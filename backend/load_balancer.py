import os
import socket
import time
import json
import requests
import threading
import subprocess
import asyncio
import re  # for parsing socat output
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
import ipaddress

# ====================================================
# Configuration
# ====================================================
CONFIG_FILE = "data/servers.json"
CHECK_INTERVAL = 5  # seconds

# Define a forced rotation interval (in seconds) for round-robin mode.
ROTATION_INTERVAL = 60  # seconds

# ====================================================
# Global Variables for Event Loop and WebSocket Manager
# ====================================================
event_loop = None  # This will be set in the lifespan handler.

class ConnectionManager:
    def __init__(self):
        self.active_connections = []
    
    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
    
    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
    
    async def broadcast(self, message: str):
        for connection in self.active_connections:
            try:
                await connection.send_text(message)
            except Exception as e:
                print("Error sending message:", e)

manager = ConnectionManager()

# ====================================================
# CONFIGURATION LOADING / SAVING
# ====================================================
def load_config():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "r") as f:
            return json.load(f)
    else:
        # Default config with an empty service list.
        return {"services": [], "mode": "failover"}

def save_config():
    with open(CONFIG_FILE, "w") as f:
        json.dump({"services": SERVICES}, f, indent=4)

config = load_config()
SERVICES = config.get("services", [])
# Note: Each service uses its own "mode" property.

# ====================================================
# HEALTH CHECK FUNCTIONS
# ====================================================
def is_server_alive(ip, port):
    try:
        with socket.create_connection((ip, port), timeout=2):
            return True
    except (socket.timeout, ConnectionRefusedError):
        return False

def check_http(ip, port, path="/"):
    try:
        url = f"http://{ip}:{port}{path}"
        response = requests.get(url, timeout=2)
        return response.status_code == 200
    except requests.RequestException:
        return False

def check_smpp(ip, port=2775):
    try:
        with socket.create_connection((ip, port), timeout=2):
            return True
    except (socket.timeout, ConnectionRefusedError):
        return False

# ====================================================
# GLOBALS FOR SERVICE STATE AND SOCAT STATS
# ====================================================
# For each service group, track:
#  - last_active: the backend currently in use
#  - index: round robin index
#  - process: the socat process
#  - restart_count: number of times socat was restarted
#  - last_start_time: timestamp when socat was last started
#  - bytes_transferred, bytes_out, bytes_in: counters from socat output
service_state = {}
for service in SERVICES:
    service_name = service.get("name")
    service_state[service_name] = {
        "last_active": None,
        "index": 0,
        "process": None,
        "restart_count": 0,
        "last_start_time": None,
        "bytes_transferred": 0,
        "bytes_out": 0,
        "bytes_in": 0
    }

# We also maintain a separate dictionary to track per-server stats.
# Keys are in the format "service_name:ip:port".
server_stats = {}
for service in SERVICES:
    service_name = service.get("name")
    for server in service.get("servers", []):
        key = f"{service_name}:{server['ip']}:{server['port']}"
        server_stats[key] = {
            "bytes_transferred": 0,
            "bytes_out": 0,
            "bytes_in": 0
        }

# For display purposes, maintain a status dictionary per service.
server_status = {}

# ====================================================
# Function to Read and Parse Socat Output for Packet/Byte Stats
# ====================================================
def read_socat_output(service_name, proc):
    """
    Reads socat's verbose output (launched with -v) from proc.stdout,
    and updates both service-level and per-server byte counters.
    It distinguishes outbound (lines containing "> ") and inbound (lines containing "< ").
    """
    # Determine the key for the currently active server.
    active_server = service_state[service_name]["last_active"]  # format "ip:port"
    server_key = f"{service_name}:{active_server}" if active_server else None
    while True:
        line = proc.stdout.readline()
        if not line:
            break
        line = line.strip()
#        print(f"[socat-{service_name}] {line}")
        if "length=" in line:
            match = re.search(r"length=(\d+)", line)
            if match:
                try:
                    bytes_count = int(match.group(1))
                    # Update service-level counters.
                    service_state[service_name]["bytes_transferred"] += bytes_count
                    if "> " in line:
                        service_state[service_name]["bytes_out"] += bytes_count
                    elif "< " in line:
                        service_state[service_name]["bytes_in"] += bytes_count
                    # Also update per-server counters.
                    if server_key:
                        if server_key not in server_stats:
                            server_stats[server_key] = {
                                "bytes_transferred": 0,
                                "bytes_out": 0,
                                "bytes_in": 0
                            }
                        server_stats[server_key]["bytes_transferred"] += bytes_count
                        if "> " in line:
                            server_stats[server_key]["bytes_out"] += bytes_count
                        elif "< " in line:
                            server_stats[server_key]["bytes_in"] += bytes_count
                except ValueError:
                    pass

# ====================================================
# BACKGROUND HEALTH CHECK / SOCAT UPDATE THREAD
# ====================================================
def update_servers():
    global server_status, SERVICES, service_state, event_loop, server_stats
    while True:
        for service in SERVICES:
            service_name = service.get("name")
            listen_port = service.get("listen_port")
            mode_for_service = service.get("mode", "failover")
            healthy_servers = []
            server_status[service_name] = {}
            
            for server in service.get("servers", []):
                ip = server["ip"]
                port = int(server["port"])
                check_type = server.get("check_type", "tcp")
                
                if check_type == "http":
                    alive = check_http(ip, port, server.get("http_path", "/"))
                elif check_type == "smpp":
                    alive = check_smpp(ip, port)
                else:
                    alive = is_server_alive(ip, port)
                
                key = f"{ip}:{port} ({check_type})"
                server_status[service_name][key] = "🟢 UP" if alive else "🔴 DOWN"
                if alive:
                    healthy_servers.append(f"{ip}:{port}")
            
            if healthy_servers:
                # --- Round Robin Mode Handling ---
                if mode_for_service == "round-robin":
                    # Force rotation: restart socat even if a process is running after a fixed interval.
                    current_proc = service_state[service_name]["process"]
                    now = time.time()
                    last_start = service_state[service_name].get("last_start_time") or 0
                    if current_proc is not None and current_proc.poll() is None:
                        # If less than ROTATION_INTERVAL has passed, do nothing.
                        if now - last_start < ROTATION_INTERVAL:
                            continue
                    idx = service_state[service_name]["index"]
                    selected_server = healthy_servers[idx % len(healthy_servers)]
                    service_state[service_name]["index"] = idx + 1
                else:  # Failover Mode
                    selected_server = healthy_servers[0]
                    if selected_server == service_state[service_name]["last_active"]:
                        current_proc = service_state[service_name]["process"]
                        if current_proc is not None and current_proc.poll() is None:
                            continue

                log_message = (f"Routing traffic on port {listen_port} to {selected_server} "
                               f"for service '{service_name}' (mode: {mode_for_service})")
                print(log_message)
                if event_loop:
                    asyncio.run_coroutine_threadsafe(manager.broadcast(log_message), event_loop)
                
                service_state[service_name]["restart_count"] += 1
                service_state[service_name]["last_start_time"] = time.time()
                
                # Terminate previous process if still running.
                prev_proc = service_state[service_name]["process"]
                if prev_proc and prev_proc.poll() is None:
                    prev_proc.terminate()
                    prev_proc.wait()
                
                # Start socat in verbose mode (-v) to capture stats.
                cmd = [
                    "socat",
                    "-v",
                    f"TCP-LISTEN:{listen_port},fork,reuseaddr",
                    f"TCP:{selected_server}"
                ]
                proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                service_state[service_name]["process"] = proc
                service_state[service_name]["last_active"] = selected_server
                
                # Initialize per-server stats for this backend if not already done.
                server_key = f"{service_name}:{selected_server}"
                if server_key not in server_stats:
                    server_stats[server_key] = {
                        "bytes_transferred": 0,
                        "bytes_out": 0,
                        "bytes_in": 0
                    }
                
                # Start a thread to parse socat output.
                threading.Thread(target=read_socat_output, args=(service_name, proc), daemon=True).start()
            else:
                log_message = f"No healthy servers available on port {listen_port} for service '{service_name}'"
                print(log_message)
                if event_loop:
                    asyncio.run_coroutine_threadsafe(manager.broadcast(log_message), event_loop)
                current_proc = service_state[service_name]["process"]
                if current_proc and current_proc.poll() is None:
                    current_proc.terminate()
                    current_proc.wait()
                service_state[service_name]["last_active"] = None
        
        time.sleep(CHECK_INTERVAL)

def start_background_thread():
    thread = threading.Thread(target=update_servers, daemon=True)
    thread.start()

# ====================================================
# Lifespan Event Handler (Startup/Shutdown)
# ====================================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    global event_loop
    event_loop = asyncio.get_running_loop()
    start_background_thread()
    yield

app = FastAPI(lifespan=lifespan)

# ====================================================
# Set Up CORS and Static Files
# ====================================================
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/assets", StaticFiles(directory="public/assets"), name="assets")

# ====================================================
# WebSocket Endpoint for Real‑Time Logs
# ====================================================
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)

# ====================================================
# Pydantic Models for Request Bodies
# ====================================================
class EditServerRequest(BaseModel):
    service: str
    ip: str
    port: int
    new_ip: Optional[str] = None
    new_port: Optional[int] = None
    check_type: Optional[str] = None

class AddServerRequest(BaseModel):
    service: str
    ip: str
    port: int
    check_type: str = "tcp"
    http_path: str = "/"

class RemoveServerRequest(BaseModel):
    service: str
    ip: str
    port: int

class SetServiceModeRequest(BaseModel):
    service: str
    mode: str = Field(..., pattern="^(failover|round-robin)$", description="Mode must be either 'failover' or 'round-robin'")

class AddServiceRequest(BaseModel):
    name: str
    listen_port: int
    mode: Optional[str] = "failover"

class EditServiceRequest(BaseModel):
    name: str
    new_name: Optional[str] = None
    listen_port: Optional[int] = None
    mode: Optional[str] = None

class RemoveServiceRequest(BaseModel):
    name: str

# ====================================================
# Additional Endpoint: Socat Stats for Service and for Server
# ====================================================
@app.get("/api/socat_stats")
def socat_stats():
    """
    Returns socat statistics aggregated per service.
    For each service, stats include:
      - last_active: currently routed destination
      - restart_count: number of times socat was restarted
      - last_start_time: UNIX timestamp when socat was last started
      - pid: process ID (if socat is running)
      - bytes_transferred: total bytes parsed from socat output (service-level)
      - bytes_out: outbound bytes (service-level)
      - bytes_in: inbound bytes (service-level)
    """
    stats = {}
    for service_name, state in service_state.items():
        stats[service_name] = {
            "last_active": state["last_active"],
            "restart_count": state["restart_count"],
            "last_start_time": state["last_start_time"],
            "pid": state["process"].pid if state["process"] and state["process"].poll() is None else None,
            "bytes_transferred": state.get("bytes_transferred", 0),
            "bytes_out": state.get("bytes_out", 0),
            "bytes_in": state.get("bytes_in", 0)
        }
    return {"socat_stats": stats}

@app.get("/api/socat_stats_by_server")
def socat_stats_by_server():
    """
    Returns socat statistics aggregated per server (backend).
    Keys are in the format "service_name:ip:port" and stats include:
      - bytes_transferred: total bytes parsed from socat output
      - bytes_out: outbound bytes
      - bytes_in: inbound bytes
    """
    return {"socat_stats_by_server": server_stats}

# ====================================================
# FastAPI Endpoints for Load Balancer & Management
# ====================================================
@app.get("/", response_class=FileResponse)
def read_index():
    return FileResponse("public/index.html")

@app.get("/api/status")
def api_status():
    return {"services": server_status}

@app.get("/api/list_services")
def list_services():
    return {"services": SERVICES}

@app.get("/api/list_servers")
def list_servers_endpoint(service: str):
    service_obj = next((s for s in SERVICES if s.get("name") == service), None)
    if not service_obj:
        raise HTTPException(status_code=404, detail="Service not found")
    return {"servers": service_obj.get("servers", [])}

@app.post("/api/edit_server")
def edit_server(req: EditServerRequest):
    service_name = req.service
    ip = req.ip
    port = req.port
    new_ip = req.new_ip
    new_port = req.new_port
    check_type = req.check_type

    service = next((s for s in SERVICES if s.get("name") == service_name), None)
    if not service:
        raise HTTPException(status_code=404, detail="Service group not found")

    for server in service.get("servers", []):
        if server["ip"] == ip and int(server["port"]) == int(port):
            if new_ip:
                server["ip"] = new_ip
            if new_port:
                server["port"] = int(new_port)
            if check_type:
                server["check_type"] = check_type
            save_config()
            return {"message": f"Server {ip}:{port} edited successfully in service '{service_name}'"}

    raise HTTPException(status_code=404, detail="Server not found in service group")

@app.post("/api/add_server")
def add_server(req: AddServerRequest):
    service_name = req.service
    ip = req.ip
    port = req.port
    check_type = req.check_type

    service = next((s for s in SERVICES if s.get("name") == service_name), None)
    if not service:
        raise HTTPException(status_code=404, detail="Service group not found")
    
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid IP address")
    
    if not (1 <= port <= 65535):
        raise HTTPException(status_code=400, detail="Port number must be between 1 and 65535")
    
    if any(s["ip"] == ip and int(s["port"]) == int(port) for s in service.get("servers", [])):
        raise HTTPException(status_code=400, detail="Server already exists in service group")

    new_server = {"ip": ip, "port": int(port), "check_type": check_type}
    if check_type == "http":
        new_server["http_path"] = req.http_path

    service.setdefault("servers", []).append(new_server)
    # Initialize per-server stats for this new server.
    server_key = f"{service_name}:{ip}:{port}"
    if server_key not in server_stats:
        server_stats[server_key] = {"bytes_transferred": 0, "bytes_out": 0, "bytes_in": 0}
    save_config()
    return {"message": f"Server {ip}:{port} added successfully to service '{service_name}'"}

@app.post("/api/remove_server")
def remove_server(req: RemoveServerRequest):
    service_name = req.service
    ip = req.ip
    port = req.port

    service = next((s for s in SERVICES if s.get("name") == service_name), None)
    if not service:
        raise HTTPException(status_code=404, detail="Service group not found")
    
    for server in service.get("servers", []):
        if server["ip"] == ip and int(server["port"]) == int(port):
            service.get("servers", []).remove(server)
            # Remove per-server stats if they exist.
            server_key = f"{service_name}:{ip}:{port}"
            if server_key in server_stats:
                del server_stats[server_key]
            save_config()
            return {"message": f"Server {ip}:{port} removed successfully from service '{service_name}'"}
    
    raise HTTPException(status_code=404, detail="Server not found in service group")

@app.post("/api/set_service_mode")
def set_service_mode(req: SetServiceModeRequest):
    service_name = req.service
    mode = req.mode
    service = next((s for s in SERVICES if s.get("name") == service_name), None)
    if not service:
        raise HTTPException(status_code=404, detail="Service not found")
    service["mode"] = mode
    save_config()
    return {"message": f"Mode for service '{service_name}' changed to {mode}"}

@app.post("/api/add_service")
def add_service(req: AddServiceRequest):
    name = req.name
    listen_port = req.listen_port
    mode = req.mode
    if not name or not listen_port:
        raise HTTPException(status_code=400, detail="Missing name or listen_port")
    if any(s.get("name") == name for s in SERVICES):
        raise HTTPException(status_code=400, detail="Service group already exists")
    
    new_service = {"name": name, "listen_port": int(listen_port), "mode": mode, "servers": []}
    SERVICES.append(new_service)
    service_state[name] = {
        "last_active": None,
        "index": 0,
        "process": None,
        "restart_count": 0,
        "last_start_time": None,
        "bytes_transferred": 0,
        "bytes_out": 0,
        "bytes_in": 0
    }
    save_config()
    return {"message": f"Service '{name}' added successfully"}

@app.post("/api/edit_service")
def edit_service(req: EditServiceRequest):
    service = next((s for s in SERVICES if s.get("name") == req.name), None)
    if not service:
        raise HTTPException(status_code=404, detail="Service not found")
    old_name = service.get("name")
    if req.new_name:
        if any(s.get("name") == req.new_name for s in SERVICES):
            raise HTTPException(status_code=400, detail="A service with that new name already exists")
        service["name"] = req.new_name
        service_state[req.new_name] = service_state.pop(old_name)
    if req.listen_port:
        service["listen_port"] = req.listen_port
        state = service_state[service.get("name")]
        if state["process"] and state["process"].poll() is None:
            state["process"].terminate()
            state["process"].wait()
            state["last_active"] = None
    if req.mode:
        if req.mode not in ["failover", "round-robin"]:
            raise HTTPException(status_code=400, detail="Invalid mode")
        service["mode"] = req.mode
    save_config()
    return {"message": f"Service '{req.name}' updated successfully."}

@app.post("/api/remove_service")
def remove_service(req: RemoveServiceRequest):
    service = next((s for s in SERVICES if s.get("name") == req.name), None)
    if not service:
        raise HTTPException(status_code=404, detail="Service not found")
    state = service_state.get(req.name)
    if state and state["process"] and state["process"].poll() is None:
        state["process"].terminate()
        state["process"].wait()
    SERVICES.remove(service)
    if req.name in service_state:
        del service_state[req.name]
    save_config()
    return {"message": f"Service '{req.name}' removed successfully."}

# ====================================================
# Main entry point
# ====================================================
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=5000)
