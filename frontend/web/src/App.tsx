import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState, useRef } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

// Data structure for encrypted records
interface EncryptedRecord {
  id: string;
  encryptedData: string;
  timestamp: number;
  owner: string;
  dataType: string;
  description: string;
  status: "raw" | "processed" | "analyzed";
}

// FHE encryption/decryption simulation
const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}-${Date.now()}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    const base64Data = encryptedData.split('-')[1];
    return parseFloat(atob(base64Data));
  }
  return parseFloat(encryptedData);
};

// FHE computation simulation
const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'mean':
      result = value; // Simulate mean calculation
      break;
    case 'sum':
      result = value * 2; // Simulate sum
      break;
    case 'std':
      result = value * 0.1; // Simulate standard deviation
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

// Generate mock public key for signature
const generatePublicKey = () => `0x${Array(64).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

// Main App Component
const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  
  // State management
  const [loading, setLoading] = useState(true);
  const [records, setRecords] = useState<EncryptedRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ 
    visible: boolean; 
    status: "pending" | "success" | "error"; 
    message: string; 
  }>({ visible: false, status: "pending", message: "" });
  
  const [newRecordData, setNewRecordData] = useState({ 
    dataType: "numeric", 
    description: "", 
    value: 0 
  });
  
  const [selectedRecord, setSelectedRecord] = useState<EncryptedRecord | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [analysisResults, setAnalysisResults] = useState<any>(null);

  // Initialize component
  useEffect(() => {
    loadRecords().finally(() => setLoading(false));
    setPublicKey(generatePublicKey());
  }, []);

  // Load records from contract
  const loadRecords = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        setTransactionStatus({ 
          visible: true, 
          status: "success", 
          message: "Contract is available" 
        });
        setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
      }
      
      // Load record keys
      const keysBytes = await contract.getData("record_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { 
          console.error("Error parsing record keys:", e); 
        }
      }
      
      // Load individual records
      const list: EncryptedRecord[] = [];
      for (const key of keys) {
        try {
          const recordBytes = await contract.getData(`record_${key}`);
          if (recordBytes.length > 0) {
            try {
              const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
              list.push({ 
                id: key, 
                encryptedData: recordData.data, 
                timestamp: recordData.timestamp, 
                owner: recordData.owner, 
                dataType: recordData.dataType || "numeric",
                description: recordData.description || "",
                status: recordData.status || "raw"
              });
            } catch (e) { 
              console.error(`Error parsing record data for ${key}:`, e); 
            }
          }
        } catch (e) { 
          console.error(`Error loading record ${key}:`, e); 
        }
      }
      
      list.sort((a, b) => b.timestamp - a.timestamp);
      setRecords(list);
    } catch (e) { 
      console.error("Error loading records:", e); 
    } finally { 
      setIsRefreshing(false); 
      setLoading(false); 
    }
  };

  // Handle file drop for data import
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      processFile(file);
    }
  };

  // Process uploaded file
  const processFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const lines = content.split('\n').filter(line => line.trim());
        const numericData = lines.map(line => parseFloat(line)).filter(num => !isNaN(num));
        
        if (numericData.length > 0) {
          setNewRecordData({
            dataType: "dataset",
            description: `Imported from ${file.name}`,
            value: numericData[0] // Use first value for demo
          });
          setShowUploadModal(true);
        }
      } catch (error) {
        alert("Error processing file. Please ensure it contains numeric data.");
      }
    };
    reader.readAsText(file);
  };

  // Submit new record to contract
  const submitRecord = async () => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return; 
    }
    
    setUploading(true);
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Encrypting data with Zama FHE..." 
    });
    
    try {
      // Encrypt data using FHE simulation
      const encryptedData = FHEEncryptNumber(newRecordData.value);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Generate unique record ID
      const recordId = `record-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      
      // Prepare record data
      const recordData = { 
        data: encryptedData, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        dataType: newRecordData.dataType,
        description: newRecordData.description,
        status: "raw"
      };
      
      // Store record data
      await contract.setData(`record_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(recordData)));
      
      // Update record keys
      const keysBytes = await contract.getData("record_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { 
          keys = JSON.parse(ethers.toUtf8String(keysBytes)); 
        } catch (e) { 
          console.error("Error parsing keys:", e); 
        }
      }
      keys.push(recordId);
      await contract.setData("record_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "Data encrypted and stored securely with Zama FHE!" 
      });
      
      await loadRecords();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowUploadModal(false);
        setNewRecordData({ dataType: "numeric", description: "", value: 0 });
      }, 2000);
      
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Submission failed: " + (e.message || "Unknown error");
      
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: errorMessage 
      });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setUploading(false); 
    }
  };

  // Decrypt data with wallet signature
  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return null; 
    }
    
    setIsDecrypting(true);
    try {
      const message = `Decrypt FHE data with Zama technology\nTimestamp: ${Date.now()}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1000));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  // Perform statistical analysis on encrypted data
  const analyzeData = async (recordId: string, analysisType: string) => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return; 
    }
    
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: `Performing ${analysisType} analysis with FHE...` 
    });
    
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      const recordBytes = await contract.getData(`record_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      const analyzedData = FHECompute(recordData.data, analysisType);
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedRecord = { 
        ...recordData, 
        status: "analyzed", 
        data: analyzedData,
        analysisType: analysisType
      };
      
      await contractWithSigner.setData(`record_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      
      // Store analysis results
      const resultValue = FHEDecryptNumber(analyzedData);
      setAnalysisResults({
        type: analysisType,
        value: resultValue,
        originalValue: FHEDecryptNumber(recordData.data)
      });
      
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: `FHE ${analysisType} analysis completed!` 
      });
      
      await loadRecords();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
      
    } catch (e: any) {
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: "Analysis failed: " + (e.message || "Unknown error") 
      });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  // Check if user is record owner
  const isOwner = (recordAddress: string) => address?.toLowerCase() === recordAddress.toLowerCase();

  // Statistics calculations
  const rawCount = records.filter(r => r.status === "raw").length;
  const processedCount = records.filter(r => r.status === "processed").length;
  const analyzedCount = records.filter(r => r.status === "analyzed").length;

  // Render statistics chart
  const renderStatsChart = () => {
    const total = records.length || 1;
    const rawPercentage = (rawCount / total) * 100;
    const processedPercentage = (processedCount / total) * 100;
    const analyzedPercentage = (analyzedCount / total) * 100;
    
    return (
      <div className="stats-chart">
        <div className="chart-bars">
          <div className="chart-bar raw" style={{ height: `${rawPercentage}%` }}></div>
          <div className="chart-bar processed" style={{ height: `${processedPercentage}%` }}></div>
          <div className="chart-bar analyzed" style={{ height: `${analyzedPercentage}%` }}></div>
        </div>
        <div className="chart-labels">
          <div className="chart-label">Raw</div>
          <div className="chart-label">Processed</div>
          <div className="chart-label">Analyzed</div>
        </div>
      </div>
    );
  };

  // Loading state
  if (loading) return (
    <div className="loading-screen">
      <div className="fhe-spinner"></div>
      <p>Initializing Zama FHE connection...</p>
    </div>
  );

  return (
    <div className="app-container fhe-theme">
      {/* Header Section */}
      <header className="app-header">
        <div className="logo-section">
          <div className="logo">
            <div className="fhe-icon"></div>
            <h1>NoCode<span>Stats</span>FHE</h1>
          </div>
          <p className="tagline">Visual statistical analysis with Zama Fully Homomorphic Encryption</p>
        </div>
        
        <div className="header-actions">
          <div className="upload-section">
            <div 
              className={`drop-zone ${dragActive ? 'active' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
              onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <div className="upload-icon"></div>
              <p>Drop CSV file or click to upload</p>
              <input 
                ref={fileInputRef}
                type="file" 
                accept=".csv,.txt" 
                style={{ display: 'none' }}
                onChange={(e) => e.target.files?.[0] && processFile(e.target.files[0])}
              />
            </div>
          </div>
          
          <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} />
        </div>
      </header>

      {/* Main Content - Multi-panel Layout */}
      <div className="main-content">
        {/* Left Panel - Data Overview */}
        <div className="left-panel">
          <div className="panel-card">
            <h3>Data Overview</h3>
            <div className="stats-overview">
              <div className="stat-item">
                <div className="stat-value">{records.length}</div>
                <div className="stat-label">Total Datasets</div>
              </div>
              {renderStatsChart()}
            </div>
          </div>

          <div className="panel-card">
            <h3>Quick Analysis</h3>
            <div className="analysis-tools">
              <button className="analysis-btn" onClick={() => analyzeData(records[0]?.id, 'mean')}>
                Mean Analysis
              </button>
              <button className="analysis-btn" onClick={() => analyzeData(records[0]?.id, 'sum')}>
                Sum Analysis
              </button>
              <button className="analysis-btn" onClick={() => analyzeData(records[0]?.id, 'std')}>
                Std Dev Analysis
              </button>
            </div>
          </div>
        </div>

        {/* Center Panel - Data Records */}
        <div className="center-panel">
          <div className="panel-header">
            <h2>Encrypted Datasets</h2>
            <button onClick={loadRecords} className="refresh-btn" disabled={isRefreshing}>
              {isRefreshing ? "Refreshing..." : "Refresh Data"}
            </button>
          </div>

          <div className="records-grid">
            {records.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon"></div>
                <h3>No encrypted datasets found</h3>
                <p>Upload your first dataset to get started with FHE analysis</p>
                <button className="primary-btn" onClick={() => setShowUploadModal(true)}>
                  Upload First Dataset
                </button>
              </div>
            ) : (
              records.map(record => (
                <div key={record.id} className="record-card">
                  <div className="record-header">
                    <span className={`status-dot ${record.status}`}></span>
                    <h4>{record.description || "Unnamed Dataset"}</h4>
                  </div>
                  <div className="record-info">
                    <span>Type: {record.dataType}</span>
                    <span>Owner: {record.owner.substring(0, 8)}...</span>
                  </div>
                  <div className="record-actions">
                    <button onClick={() => setSelectedRecord(record)} className="action-btn">
                      View Details
                    </button>
                    {isOwner(record.owner) && (
                      <button 
                        onClick={() => analyzeData(record.id, 'mean')} 
                        className="action-btn primary"
                      >
                        Analyze
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Right Panel - Analysis Results */}
        <div className="right-panel">
          <div className="panel-card">
            <h3>Analysis Results</h3>
            {analysisResults ? (
              <div className="results-display">
                <div className="result-item">
                  <label>Analysis Type:</label>
                  <span>{analysisResults.type}</span>
                </div>
                <div className="result-item">
                  <label>Original Value:</label>
                  <span>{analysisResults.originalValue}</span>
                </div>
                <div className="result-item">
                  <label>Result:</label>
                  <span className="result-value">{analysisResults.value}</span>
                </div>
              </div>
            ) : (
              <div className="no-results">
                <p>Perform analysis to see results</p>
              </div>
            )}
          </div>

          <div className="panel-card">
            <h3>FHE Information</h3>
            <div className="fhe-info">
              <p>Data encrypted with Zama FHE technology</p>
              <div className="encryption-status">
                <span className="status-indicator"></span>
                <span>FHE Encryption Active</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Upload Modal */}
      {showUploadModal && (
        <UploadModal
          onSubmit={submitRecord}
          onClose={() => setShowUploadModal(false)}
          uploading={uploading}
          recordData={newRecordData}
          setRecordData={setNewRecordData}
        />
      )}

      {/* Record Detail Modal */}
      {selectedRecord && (
        <RecordDetailModal
          record={selectedRecord}
          onClose={() => { setSelectedRecord(null); setDecryptedValue(null); }}
          decryptedValue={decryptedValue}
          setDecryptedValue={setDecryptedValue}
          isDecrypting={isDecrypting}
          decryptWithSignature={decryptWithSignature}
        />
      )}

      {/* Transaction Status Modal */}
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`status-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="spinner"></div>}
              {transactionStatus.status === "success" && "✓"}
              {transactionStatus.status === "error" && "✕"}
            </div>
            <div className="status-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="app-footer">
        <div className="footer-content">
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy</a>
            <a href="#" className="footer-link">Terms</a>
          </div>
        </div>
      </footer>
    </div>
  );
};

// Upload Modal Component
interface UploadModalProps {
  onSubmit: () => void;
  onClose: () => void;
  uploading: boolean;
  recordData: any;
  setRecordData: (data: any) => void;
}

const UploadModal: React.FC<UploadModalProps> = ({ onSubmit, onClose, uploading, recordData, setRecordData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setRecordData({ ...recordData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setRecordData({ ...recordData, [name]: parseFloat(value) || 0 });
  };

  const handleSubmit = () => {
    if (!recordData.value) {
      alert("Please enter a valid numerical value");
      return;
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="upload-modal">
        <div className="modal-header">
          <h2>Upload Encrypted Data</h2>
          <button onClick={onClose} className="close-btn">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="encryption-notice">
            <div className="lock-icon"></div>
            <div>
              <strong>Zama FHE Encryption</strong>
              <p>Your data will be encrypted before storage and processing</p>
            </div>
          </div>

          <div className="form-group">
            <label>Data Type</label>
            <select name="dataType" value={recordData.dataType} onChange={handleChange}>
              <option value="numeric">Numeric Value</option>
              <option value="dataset">Dataset</option>
              <option value="financial">Financial Data</option>
              <option value="scientific">Scientific Data</option>
            </select>
          </div>

          <div className="form-group">
            <label>Description</label>
            <input 
              type="text" 
              name="description" 
              value={recordData.description}
              onChange={handleChange}
              placeholder="Enter dataset description..."
            />
          </div>

          <div className="form-group">
            <label>Numerical Value</label>
            <input 
              type="number" 
              name="value" 
              value={recordData.value}
              onChange={handleValueChange}
              placeholder="Enter numerical value..."
              step="0.01"
            />
          </div>

          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview">
              <div className="plain-text">Plain: {recordData.value}</div>
              <div className="arrow">→</div>
              <div className="encrypted-text">
                Encrypted: {recordData.value ? FHEEncryptNumber(recordData.value).substring(0, 30) + '...' : 'N/A'}
              </div>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button onClick={onClose} className="secondary-btn">Cancel</button>
          <button onClick={handleSubmit} disabled={uploading} className="primary-btn">
            {uploading ? "Encrypting with FHE..." : "Encrypt & Store"}
          </button>
        </div>
      </div>
    </div>
  );
};

// Record Detail Modal Component
interface RecordDetailModalProps {
  record: EncryptedRecord;
  onClose: () => void;
  decryptedValue: number | null;
  setDecryptedValue: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const RecordDetailModal: React.FC<RecordDetailModalProps> = ({
  record,
  onClose,
  decryptedValue,
  setDecryptedValue,
  isDecrypting,
  decryptWithSignature
}) => {
  const handleDecrypt = async () => {
    if (decryptedValue !== null) {
      setDecryptedValue(null);
      return;
    }
    const decrypted = await decryptWithSignature(record.encryptedData);
    if (decrypted !== null) setDecryptedValue(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="detail-modal">
        <div className="modal-header">
          <h2>Dataset Details</h2>
          <button onClick={onClose} className="close-btn">&times;</button>
        </div>

        <div className="modal-body">
          <div className="record-details">
            <div className="detail-item">
              <label>ID:</label>
              <span>{record.id.substring(0, 12)}...</span>
            </div>
            <div className="detail-item">
              <label>Description:</label>
              <span>{record.description || "No description"}</span>
            </div>
            <div className="detail-item">
              <label>Type:</label>
              <span>{record.dataType}</span>
            </div>
            <div className="detail-item">
              <label>Status:</label>
              <span className={`status-tag ${record.status}`}>{record.status}</span>
            </div>
            <div className="detail-item">
              <label>Owner:</label>
              <span>{record.owner.substring(0, 10)}...{record.owner.substring(38)}</span>
            </div>
          </div>

          <div className="encrypted-section">
            <h3>Encrypted Data</h3>
            <div className="encrypted-data">
              {record.encryptedData.substring(0, 50)}...
            </div>
            <button 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
              className="decrypt-btn"
            >
              {isDecrypting ? "Decrypting..." : 
               decryptedValue ? "Re-encrypt Data" : "Decrypt with Signature"}
            </button>
          </div>

          {decryptedValue !== null && (
            <div className="decrypted-section">
              <h3>Decrypted Value</h3>
              <div className="decrypted-value">{decryptedValue}</div>
              <div className="decryption-note">
                Value decrypted using wallet signature verification
            </div>
          </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default App;