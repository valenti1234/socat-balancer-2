import React, { useState, useEffect, useRef } from 'react';
import { Activity, Server, Settings, Plus, Edit2, Trash2, RefreshCcw, AlertCircle } from 'lucide-react';

interface Service {
  name: string;
  listen_port: number;
  servers: Server[];
}

interface Server {
  ip: string;
  port: number;
  check_type: string;
  http_path?: string;
}

interface Status {
  [serviceName: string]: {
    [serverKey: string]: string;
  };
}

function App() {
  const [services, setServices] = useState<Service[]>([]);
  const [status, setStatus] = useState<Status>({});
  const [mode, setMode] = useState('failover');
  const [logs, setLogs] = useState<string[]>([]);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [backendAvailable, setBackendAvailable] = useState(false);

  useEffect(() => {
    checkBackendStatus();
  }, []);

  const checkBackendStatus = async () => {
    try {
      const response = await fetch('/api/status');
      if (response.ok) {
        setBackendAvailable(true);
        initializeWebSocket();
        fetchData();
      } else {
        throw new Error('Backend not available');
      }
    } catch (error) {
      setBackendAvailable(false);
      setError('Backend server is not available. Please ensure the FastAPI server is running.');
      setIsLoading(false);
    }
  };

  const initializeWebSocket = () => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    wsRef.current = new WebSocket(wsUrl);
    wsRef.current.onmessage = (event) => {
      setLogs(prev => [...prev, event.data]);
    };
    wsRef.current.onerror = () => {
      setError('WebSocket connection failed');
    };

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  };

  const fetchData = async () => {
    if (!backendAvailable) return;

    setIsLoading(true);
    setError(null);
    try {
      const [servicesRes, statusRes] = await Promise.all([
        fetch('/api/list_services'),
        fetch('/api/status')
      ]);
      
      if (!servicesRes.ok || !statusRes.ok) {
        throw new Error('Failed to fetch data from server');
      }

      const servicesData = await servicesRes.json();
      const statusData = await statusRes.json();
      
      setServices(servicesData.services);
      setStatus(statusData.services);
      setMode(statusData.mode);
    } catch (error) {
      console.error('Error fetching data:', error);
      setError('Failed to load data. Please try again.');
    }
    setIsLoading(false);
  };

  const handleModeChange = async () => {
    if (!backendAvailable) return;

    const newMode = mode === 'failover' ? 'round-robin' : 'failover';
    try {
      const response = await fetch('/api/set_mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: newMode })
      });

      if (!response.ok) {
        throw new Error('Failed to change mode');
      }

      setMode(newMode);
    } catch (error) {
      console.error('Error changing mode:', error);
      setError('Failed to change mode. Please try again.');
    }
  };

  if (!backendAvailable) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg shadow-md max-w-md w-full">
          <div className="flex items-center justify-center text-red-600 mb-4">
            <AlertCircle className="h-12 w-12" />
          </div>
          <h1 className="text-xl font-semibold text-center mb-4">Backend Not Available</h1>
          <p className="text-gray-600 text-center mb-6">
            The load balancer backend service is not accessible. Please ensure the FastAPI server is running.
          </p>
          <button
            onClick={checkBackendStatus}
            className="w-full flex items-center justify-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
          >
            <RefreshCcw className="h-4 w-4 mr-2" />
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-4 sm:px-6 lg:px-8 flex justify-between items-center">
          <div className="flex items-center space-x-3">
            <Server className="h-8 w-8 text-indigo-600" />
            <h1 className="text-2xl font-bold text-gray-900">Load Balancer Dashboard</h1>
          </div>
          <button
            onClick={handleModeChange}
            className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
          >
            <Settings className="h-4 w-4 mr-2" />
            Mode: {mode}
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {error && (
          <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-md">
            <p className="text-sm text-red-600">{error}</p>
          </div>
        )}
        
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Services Panel */}
          <div className="lg:col-span-2 space-y-6">
            <div className="bg-white shadow rounded-lg p-6">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-lg font-medium text-gray-900">Services</h2>
                <button
                  onClick={fetchData}
                  className="inline-flex items-center px-3 py-1.5 border border-transparent text-sm font-medium rounded-md text-indigo-600 bg-indigo-100 hover:bg-indigo-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  <RefreshCcw className="h-4 w-4 mr-1" />
                  Refresh
                </button>
              </div>

              {isLoading ? (
                <div className="flex justify-center items-center h-32">
                  <Activity className="h-8 w-8 text-indigo-600 animate-spin" />
                </div>
              ) : services.length === 0 ? (
                <div className="text-center py-12">
                  <p className="text-gray-500">No services configured yet</p>
                  <button className="mt-4 inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500">
                    <Plus className="h-4 w-4 mr-1" />
                    Add First Service
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  {services.map((service) => (
                    <div
                      key={service.name}
                      className="border rounded-lg p-4 hover:border-indigo-500 transition-colors cursor-pointer"
                      onClick={() => setSelectedService(service.name)}
                    >
                      <div className="flex justify-between items-start mb-4">
                        <div>
                          <h3 className="text-lg font-medium text-gray-900">{service.name}</h3>
                          <p className="text-sm text-gray-500">Port: {service.listen_port}</p>
                        </div>
                        <div className="flex space-x-2">
                          <button className="p-1 text-gray-400 hover:text-indigo-600">
                            <Edit2 className="h-4 w-4" />
                          </button>
                          <button className="p-1 text-gray-400 hover:text-red-600">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>

                      <div className="space-y-2">
                        {service.servers.map((server) => (
                          <div
                            key={`${server.ip}:${server.port}`}
                            className="flex justify-between items-center bg-gray-50 rounded p-2"
                          >
                            <div>
                              <p className="text-sm font-medium">{server.ip}:{server.port}</p>
                              <p className="text-xs text-gray-500">Type: {server.check_type}</p>
                            </div>
                            <div className="flex items-center space-x-2">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                                status[service.name]?.[`${server.ip}:${server.port} (${server.check_type})`]?.includes('UP')
                                  ? 'bg-green-100 text-green-800'
                                  : 'bg-red-100 text-red-800'
                              }`}>
                                {status[service.name]?.[`${server.ip}:${server.port} (${server.check_type})`] || 'Unknown'}
                              </span>
                            </div>
                          </div>
                        ))}
                        <button className="w-full flex items-center justify-center px-3 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500">
                          <Plus className="h-4 w-4 mr-1" />
                          Add Server
                        </button>
                      </div>
                    </div>
                  ))}
                  <button className="w-full flex items-center justify-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500">
                    <Plus className="h-4 w-4 mr-1" />
                    Add Service
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Logs Panel */}
          <div className="bg-white shadow rounded-lg p-6">
            <h2 className="text-lg font-medium text-gray-900 mb-6">Real-time Logs</h2>
            <div className="h-[600px] overflow-y-auto bg-gray-50 rounded-lg p-4">
              {logs.map((log, index) => (
                <div key={index} className="text-sm text-gray-600 mb-2">
                  <span className="text-gray-400">[{new Date().toLocaleTimeString()}]</span> {log}
                </div>
              ))}
              {logs.length === 0 && (
                <p className="text-gray-500 text-center mt-4">No logs available</p>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;