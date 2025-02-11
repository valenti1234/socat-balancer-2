import os
import socket
import time
import json
import requests
import threading
import subprocess
import asyncio
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import ipaddress  # Import at the top of your file if not already imported.


# ====================================================
# Configuration
# ====================================================
CONFIG_FILE = "servers.json"
CHECK_INTERVAL = 5  # seconds

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
        return {"services": [], "mode": "failover"}

def save_config():
    with open(CONFIG_FILE, "w") as f:
        json.dump({"services": SERVICES, "mode": MODE}, f, indent=4)

config = load_config()
SERVICES = config.get("services", [])
MODE = config.get("mode", "failover")

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
# GLOBALS FOR SERVICE STATE
# ====================================================
# For each service group, track the last active backend, round-robin index, and the socat process.
service_state = {}
for service in SERVICES:
    service_name = service.get("name")
    service_state[service_name] = {"last_active": None, "index": 0, "process": None}

# For display purposes, maintain a status dictionary per service.
server_status = {}

# ====================================================
# BACKGROUND HEALTH CHECK / SOCAT UPDATE THREAD
# ====================================================
def update_servers():
    global server_status, MODE, SERVICES, service_state, event_loop
    while True:
        for service in SERVICES:
            service_name = service.get("name")
            listen_port = service.get("listen_port")
            healthy_servers = []
            # Reset the status for this service.
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
                # Choose healthy server based on load-balancing mode.
                if MODE == "failover":
                    selected_server = healthy_servers[0]
                else:  # round-robin
                    idx = service_state[service_name]["index"]
                    selected_server = healthy_servers[idx % len(healthy_servers)]
                    service_state[service_name]["index"] = idx + 1

                # If the selected backend has changed, update socat.
                if selected_server != service_state[service_name]["last_active"]:
                    log_message = f"Routing traffic on port {listen_port} to {selected_server} for service '{service_name}'"
                    print(log_message)
                    if event_loop:
                        asyncio.run_coroutine_threadsafe(manager.broadcast(log_message), event_loop)
                    # Terminate the previous socat process, if any.
                    prev_proc = service_state[service_name]["process"]
                    if prev_proc and prev_proc.poll() is None:
                        prev_proc.terminate()
                        prev_proc.wait()
                    # Start a new socat process.
                    cmd = [
                        "socat",
                        f"TCP-LISTEN:{listen_port},fork,reuseaddr",
                        f"TCP:{selected_server}"
                    ]
                    proc = subprocess.Popen(cmd)
                    service_state[service_name]["process"] = proc
                    service_state[service_name]["last_active"] = selected_server
            else:
                log_message = f"No healthy servers available on port {listen_port} for service '{service_name}'"
                print(log_message)
                if event_loop:
                    asyncio.run_coroutine_threadsafe(manager.broadcast(log_message), event_loop)
                # Terminate any running socat process if no healthy server.
                prev_proc = service_state[service_name]["process"]
                if prev_proc and prev_proc.poll() is None:
                    prev_proc.terminate()
                    prev_proc.wait()
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
    event_loop = asyncio.get_running_loop()  # Capture the running event loop.
    start_background_thread()  # Startup: start the background thread.
    yield
    # (Optional) Shutdown cleanup can be added here.

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
app.mount("/assets", StaticFiles(directory="assets"), name="assets")

# ====================================================
# WebSocket Endpoint for Real‑Time Logs
# ====================================================
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            # Keep the connection open. (You can also handle incoming messages here if needed.)
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

class SetModeRequest(BaseModel):
    mode: str

class AddServiceRequest(BaseModel):
    name: str
    listen_port: int

# New models for editing and removing services.
class EditServiceRequest(BaseModel):
    name: str
    new_name: Optional[str] = None
    listen_port: Optional[int] = None

class RemoveServiceRequest(BaseModel):
    name: str

# ====================================================
# FastAPI Endpoints for Load Balancer & Management
# ====================================================
@app.get("/", response_class=FileResponse)
def read_index():
    return "assets/index.html"

@app.get("/api/status")
def api_status():
    return {"services": server_status, "mode": MODE}

@app.get("/api/list_services")
def list_services():
    return {"services": SERVICES}

# List servers for a specific service.
@app.get("/api/list_servers")
def list_servers(service: str):
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

    # Validate that the service exists.
    service = next((s for s in SERVICES if s.get("name") == service_name), None)
    if not service:
        raise HTTPException(status_code=404, detail="Service group not found")
    
    # Validate that the IP address is valid.
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid IP address")
    
    # Validate that the port is in the range 1 to 65535.
    if not (1 <= port <= 65535):
        raise HTTPException(status_code=400, detail="Invalid port number, must be between 1 and 65535")
    
    # Check if a server with the same IP and port already exists in the service group.
    if any(s["ip"] == ip and int(s["port"]) == int(port) for s in service.get("servers", [])):
        raise HTTPException(status_code=400, detail="Server already exists in service group")

    # Create the new server object.
    new_server = {"ip": ip, "port": int(port), "check_type": check_type}
    if check_type == "http":
        new_server["http_path"] = req.http_path

    # Append the new server and persist the configuration.
    service.setdefault("servers", []).append(new_server)
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
            save_config()
            return {"message": f"Server {ip}:{port} removed successfully from service '{service_name}'"}

    raise HTTPException(status_code=404, detail="Server not found in service group")

@app.post("/api/set_mode")
def set_mode(req: SetModeRequest):
    global MODE
    mode = req.mode
    if mode in ["failover", "round-robin"]:
        MODE = mode
        save_config()
        return {"message": f"Mode changed to {MODE}"}
    raise HTTPException(status_code=400, detail="Invalid mode")

@app.post("/api/add_service")
def add_service(req: AddServiceRequest):
    name = req.name
    listen_port = req.listen_port

    if not name or not listen_port:
        raise HTTPException(status_code=400, detail="Missing name or listen_port")
    if any(s.get("name") == name for s in SERVICES):
        raise HTTPException(status_code=400, detail="Service group already exists")

    new_service = {"name": name, "listen_port": int(listen_port), "servers": []}
    SERVICES.append(new_service)
    service_state[name] = {"last_active": None, "index": 0, "process": None}
    save_config()
    return {"message": f"Service '{name}' added successfully"}

# --- New Endpoints for Editing and Removing a Service ---

@app.post("/api/edit_service")
def edit_service(req: EditServiceRequest):
    global SERVICES, service_state
    service = next((s for s in SERVICES if s.get("name") == req.name), None)
    if not service:
        raise HTTPException(status_code=404, detail="Service not found")
    old_name = service.get("name")
    # Update service name if a new name is provided.
    if req.new_name:
        if any(s.get("name") == req.new_name for s in SERVICES):
            raise HTTPException(status_code=400, detail="A service with that new name already exists")
        service["name"] = req.new_name
        # Update the service_state dictionary accordingly.
        service_state[req.new_name] = service_state.pop(old_name)
    # Update the listen_port if provided.
    if req.listen_port:
        service["listen_port"] = req.listen_port
        # Kill any running socat process so it can be restarted.
        state = service_state[service.get("name")]
        if state["process"] and state["process"].poll() is None:
            state["process"].terminate()
            state["process"].wait()
            state["last_active"] = None
    save_config()
    return {"message": f"Service '{req.name}' updated successfully."}

@app.post("/api/remove_service")
def remove_service(req: RemoveServiceRequest):
    global SERVICES, service_state
    service = next((s for s in SERVICES if s.get("name") == req.name), None)
    if not service:
        raise HTTPException(status_code=404, detail="Service not found")
    # Kill any running socat process.
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
# Main entry point (if not running via uvicorn CLI)
# ====================================================
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=5000)
