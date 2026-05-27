import { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { parseQrData, buildUrlFromQr } from "../services/qrDiscovery";
import { syncService } from "../services/syncService";

interface QrScannerProps {
  onConnected: (sessionId: string) => void;
  onError: (msg: string) => void;
}

export default function QrScanner({ onConnected, onError }: QrScannerProps) {
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const containerId = "qr-reader";

  useEffect(() => {
    return () => {
      if (scannerRef.current?.isScanning) {
        scannerRef.current.stop();
      }
    };
  }, []);

  const startScan = async () => {
    try {
      const scanner = new Html5Qrcode(containerId);
      scannerRef.current = scanner;
      setIsScanning(true);

      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decodedText) => {
          const data = parseQrData(decodedText);
          if (!data) {
            onError("Invalid QR code format");
            return;
          }

          scanner.stop();
          setIsScanning(false);

          const url = buildUrlFromQr(data);
          syncService.connect(url, data.sessionId);
          syncService.setConnectHandler(() => {
            onConnected(data.sessionId);
          });
        },
        () => {
          // QR not detected yet — silent
        }
      );
    } catch (err) {
      onError(`Camera error: ${(err as Error).message}`);
      setIsScanning(false);
    }
  };

  const stopScan = async () => {
    if (scannerRef.current?.isScanning) {
      await scannerRef.current.stop();
    }
    setIsScanning(false);
  };

  return (
    <div className="qr-scanner">
      <div id={containerId} style={{ width: "100%", maxWidth: 320 }} />
      {!isScanning ? (
        <button className="btn-primary" onClick={startScan}>
          Scan QR Code
        </button>
      ) : (
        <button className="btn-danger" onClick={stopScan}>
          Cancel
        </button>
      )}
    </div>
  );
}
