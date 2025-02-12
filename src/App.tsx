import React, { useState, useEffect, useRef } from 'react';
import { Activity, Server, Settings, Plus, Edit2, Trash2, RefreshCcw, AlertCircle, X } from 'lucide-react';

interface Server {
  ip: string;
  port: number;
  check_type: string;
  http_path?: string;
}

interface Service {
  name: string;
  listen_port: number;
  mode: string;
  servers: Server[];
}

interface Status {
  [serviceName: string]: {
    [serverKey: string]: string;
  };
}

function App() {
  const [services, setServices] = useState<Service[]>([]);
  const [status, setStatus] = useState<Status>({});
  const [logs, setLogs] = useState<string[]>([]);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [backendAvailable, setBackendAvailable] = useState(false);
  const [showAddServiceModal, setShowAddServiceModal] = useState(false);
  const [showAddServerModal, setShowAddServerModal] = useState(false);
  const [showEditServiceModal, setShowEditServiceModal] = useState(false);
  const [selectedServiceForServer, setSelectedServiceForServer] = useState<string>('');
  const [selectedServiceForEdit, setSelectedServiceForEdit] = useState<Service | null>(null);
  const refreshIntervalRef = useRef<number>();

  const [newService, setNewService] = useState({
    name: '',
    listen_port: '',
    mode: 'failover'
  });

  const [editService, setEditService] = useState({
    name: '',
    new_name: '',
    listen_port: '',
    mode: 'failover'
  });

  const [newServer, setNewServer] = useState({
    ip: '',
    port: '',
    check_type: 'tcp',
    http_path: '/'
  });

  const clearLogs = () => {
    setLogs([]);
  };

  useEffect(() => {
    checkBackendStatus();
    const interval = setInterval(() => {
      if (!backendAvailable) {
        checkBackendStatus();
      }
    }, 5000);

    return () => {
      clearInterval(interval);
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
      }
    };
  }, [backendAvailable]);

  // Add auto-refresh effect
  useEffect(() => {
    if (backendAvailable) {
      // Initial fetch
      fetchData();
      
      // Set up interval for auto-refresh every 15 seconds
      refreshIntervalRef.current = window.setInterval(() => {
        fetchData();
      }, 15000);

      // Cleanup interval on unmount or when backend becomes unavailable
      return () => {
        if (refreshIntervalRef.current) {
          clearInterval(refreshIntervalRef.current);
        }
      };
    }
  }, [backendAvailable]);

  const checkBackendStatus = async () => {
    try {
      const response = await fetch('/api/status');
      const contentType = response.headers.get('content-type');
      
      if (!contentType?.includes('application/json')) {
        throw new Error('Invalid response from server');
      }
      
      await response.json();
      
      setBackendAvailable(true);
      setError(null);
      initializeWebSocket();
      fetchData();
    } catch (error) {
      setBackendAvailable(false);
      setError('Backend server is not available. Please ensure the FastAPI server is running.');
      setIsLoading(false);
    }
  };

  const initializeWebSocket = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    wsRef.current = new WebSocket(wsUrl);
    
    wsRef.current.onopen = () => {
      setError(null);
    };

    wsRef.current.onmessage = (event) => {
      setLogs(prev => [...prev, event.data]);
    };

    wsRef.current.onerror = () => {
      setError('WebSocket connection failed');
    };

    wsRef.current.onclose = () => {
      setTimeout(initializeWebSocket, 5000);
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
      
      const servicesContentType = servicesRes.headers.get('content-type');
      const statusContentType = statusRes.headers.get('content-type');
      
      if (!servicesContentType?.includes('application/json') || !statusContentType?.includes('application/json')) {
        throw new Error('Invalid response from server');
      }

      if (!servicesRes.ok || !statusRes.ok) {
        throw new Error('Failed to fetch data from server');
      }

      const servicesData = await servicesRes.json();
      const statusData = await statusRes.json();
      
      setServices(servicesData.services);
      setStatus(statusData.services);
    } catch (error) {
      console.error('Error fetching data:', error);
      setError('Failed to load data. Please try again.');
      setBackendAvailable(false);
    }
    setIsLoading(false);
  };

  const handleModeChange = async (serviceName: string) => {
    if (!backendAvailable) return;

    const service = services.find(s => s.name === serviceName);
    if (!service) return;

    const newMode = service.mode === 'failover' ? 'round-robin' : 'failover';
    try {
      const response = await fetch('/api/set_service_mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: serviceName, mode: newMode })
      });

      if (!response.ok) {
        throw new Error('Failed to change mode');
      }

      setServices(prev => prev.map(s => 
        s.name === serviceName ? { ...s, mode: newMode } : s
      ));
    } catch (error) {
      console.error('Error changing mode:', error);
      setError(`Failed to change mode for service '${serviceName}'. Please try again.`);
    }
  };

  const handleAddService = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const response = await fetch('/api/add_service', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: newService.name,
          listen_port: parseInt(newService.listen_port),
          mode: newService.mode
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to add service');
      }

      setNewService({ name: '', listen_port: '', mode: 'failover' });
      setShowAddServiceModal(false);
      fetchData();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to add service');
    }
  };

  const handleEditService = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const response = await fetch('/api/edit_service', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: editService.name,
          new_name: editService.new_name || undefined,
          listen_port: editService.listen_port ? parseInt(editService.listen_port) : undefined,
          mode: editService.mode
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to edit service');
      }

      setEditService({ name: '', new_name: '', listen_port: '', mode: 'failover' });
      setShowEditServiceModal(false);
      fetchData();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to edit service');
    }
  };

  const handleRemoveService = async (serviceName: string) => {
    if (!confirm(`Are you sure you want to remove service '${serviceName}'?`)) {
      return;
    }

    try {
      const response = await fetch('/api/remove_service', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: serviceName }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to remove service');
      }

      fetchData();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to remove service');
    }
  };

  const handleAddServer = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const response = await fetch('/api/add_server', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          service: selectedServiceForServer,
          ip: newServer.ip,
          port: parseInt(newServer.port),
          check_type: newServer.check_type,
          ...(newServer.check_type === 'http' && { http_path: newServer.http_path })
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to add server');
      }

      setNewServer({ ip: '', port: '', check_type: 'tcp', http_path: '/' });
      setShowAddServerModal(false);
      
      // Refresh the services list and status immediately after adding a server
      await fetchData();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to add server');
    }
  };

  const handleRemoveServer = async (serviceName: string, ip: string, port: number) => {
    if (!confirm(`Are you sure you want to remove server ${ip}:${port} from service '${serviceName}'?`)) {
      return;
    }

    try {
      const response = await fetch('/api/remove_server', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          service: serviceName,
          ip,
          port
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to remove server');
      }

      fetchData();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to remove server');
    }
  };

  const openAddServerModal = (serviceName: string) => {
    setSelectedServiceForServer(serviceName);
    setShowAddServerModal(true);
  };

  const openEditServiceModal = (service: Service) => {
    setSelectedServiceForEdit(service);
    setEditService({
      name: service.name,
      new_name: service.name,
      listen_port: service.listen_port.toString(),
      mode: service.mode
    });
    setShowEditServiceModal(true);
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
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-4 sm:px-6 lg:px-8 flex justify-between items-center">
          <div className="flex items-center space-x-3">
            <Server className="h-8 w-8 text-indigo-600" />
            <h1 className="text-2xl font-bold text-gray-900">Balancer Dashboard</h1>
          </div>
          <button
            onClick={fetchData}
            className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
          >
            <RefreshCcw className="h-4 w-4 mr-2" />
            Refresh Status
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
                  <button 
                    onClick={() => setShowAddServiceModal(true)}
                    className="mt-4 inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                  >
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
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleModeChange(service.name);
                            }}
                            className="px-3 py-1.5 text-sm font-medium rounded-md text-indigo-600 bg-indigo-100 hover:bg-indigo-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                          >
                            <Settings className="h-4 w-4 inline-block mr-1" />
                            {service.mode}
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              openEditServiceModal(service);
                            }}
                            className="p-1 text-gray-400 hover:text-indigo-600"
                          >
                            <Edit2 className="h-4 w-4" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRemoveService(service.name);
                            }}
                            className="p-1 text-gray-400 hover:text-red-600"
                          >
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
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRemoveServer(service.name, server.ip, server.port);
                                }}
                                className="p-1 text-gray-400 hover:text-red-600"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          </div>
                        ))}
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            openAddServerModal(service.name);
                          }}
                          className="w-full flex items-center justify-center px-3 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                        >
                          <Plus className="h-4 w-4 mr-1" />
                          Add Server
                        </button>
                      </div>
                    </div>
                  ))}
                  <button 
                    onClick={() => setShowAddServiceModal(true)}
                    className="w-full flex items-center justify-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Add Service
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="bg-white shadow rounded-lg p-6">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-lg font-medium text-gray-900">Real-time Logs</h2>
              <button
                onClick={clearLogs}
                className="inline-flex items-center px-3 py-1.5 border border-transparent text-sm font-medium rounded-md text-indigo-600 bg-indigo-100 hover:bg-indigo-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                <X className="h-4 w-4 mr-1" />
                Clear Logs
              </button>
            </div>
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

      {showAddServiceModal && (
        <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg max-w-md w-full p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-medium text-gray-900">Add New Service</h3>
              <button
                onClick={() => setShowAddServiceModal(false)}
                className="text-gray-400 hover:text-gray-500"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleAddService}>
              <div className="space-y-4">
                <div>
                  <label htmlFor="name" className="block text-sm font-medium text-gray-700">
                    Service Name
                  </label>
                  <input
                    type="text"
                    id="name"
                    value={newService.name}
                    onChange={(e) => setNewService(prev => ({ ...prev, name: e.target.value }))}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="listen_port" className="block text-sm font-medium text-gray-700">
                    Listen Port
                  </label>
                  <input
                    type="number"
                    id="listen_port"
                    value={newService.listen_port}
                    onChange={(e) => setNewService(prev => ({ ...prev, listen_port: e.target.value }))}
                    min="1"
                    max="65535"
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="mode" className="block text-sm font-medium text-gray-700">
                    Mode
                  </label>
                  <select
                    id="mode"
                    value={newService.mode}
                    onChange={(e) => setNewService(prev => ({ ...prev, mode: e.target.value }))}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  >
                    <option value="failover">Failover</option>
                    <option value="round-robin">Round Robin</option>
                  </select>
                </div>
              </div>
              <div className="mt-6 flex justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setShowAddServiceModal(false)}
                  className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  Add Service
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showEditServiceModal && selectedServiceForEdit && (
        <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg max-w-md w-full p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-medium text-gray-900">Edit Service</h3>
              <button
                onClick={() => setShowEditServiceModal(false)}
                className="text-gray-400 hover:text-gray-500"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleEditService}>
              <div className="space-y-4">
                <div>
                  <label htmlFor="new_name" className="block text-sm font-medium text-gray-700">
                    Service Name
                  </label>
                  <input
                    type="text"
                    id="new_name"
                    value={editService.new_name}
                    onChange={(e) => setEditService(prev => ({ ...prev, new_name: e.target.value }))}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="edit_listen_port" className="block text-sm font-medium text-gray-700">
                    Listen Port
                  </label>
                  <input
                    type="number"
                    id="edit_listen_port"
                    value={editService.listen_port}
                    onChange={(e) => setEditService(prev => ({ ...prev, listen_port: e.target.value }))}
                    min="1"
                    max="65535"
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="edit_mode" className="block text-sm font-medium text-gray-700">
                    Mode
                  </label>
                  <select
                    id="edit_mode"
                    value={editService.mode}
                    onChange={(e) => setEditService(prev => ({ ...prev, mode: e.target.value }))}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  >
                    <option value="failover">Failover</option>
                    <option value="round-robin">Round Robin</option>
                  </select>
                </div>
              </div>
              <div className="mt-6 flex justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setShowEditServiceModal(false)}
                  className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  Save Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showAddServerModal && (
        <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg max-w-md w-full p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-medium text-gray-900">Add New Server</h3 >
              <button
                onClick={() => setShowAddServerModal(false)}
                className="text-gray-400 hover:text-gray-500"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleAddServer}>
              <div className="space-y-4">
                <div>
                  <label htmlFor="ip" className="block text-sm font-medium text-gray-700">
                    IP Address
                  </label>
                  <input
                    type="text"
                    id="ip"
                    value={newServer.ip}
                    onChange={(e) => setNewServer(prev => ({ ...prev, ip: e.target.value }))}
                    placeholder="e.g., 192.168.1.1"
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="port" className="block text-sm font-medium text-gray-700">
                    Port
                  </label>
                  <input
                    type="number"
                    id="port"
                    value={newServer.port}
                    onChange={(e) => setNewServer(prev => ({ ...prev, port: e.target.value }))}
                    min="1"
                    max="65535"
                    placeholder="e.g., 8080"
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="check_type" className="block text-sm font-medium text-gray-700">
                    Check Type
                  </label>
                  <select
                    id="check_type"
                    value={newServer.check_type}
                    onChange={(e) => setNewServer(prev => ({ ...prev, check_type: e.target.value }))}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  >
                    <option value="tcp">TCP</option>
                    <option value="http">HTTP</option>
                    <option value="smpp">SMPP</option>
                  </select>
                </div>
                {newServer.check_type === 'http' && (
                  <div>
                    <label htmlFor="http_path" className="block text-sm font-medium text-gray-700">
                      HTTP Path
                    </label>
                    <input
                      type="text"
                      id="http_path"
                      value={newServer.http_path}
                      onChange={(e) => setNewServer(prev => ({ ...prev, http_path: e.target.value }))}
                      placeholder="e.g., /health"
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                    />
                  </div>
                )}
              </div>
              <div className="mt-6 flex justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setShowAddServerModal(false)}
                  className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  Add Server
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;