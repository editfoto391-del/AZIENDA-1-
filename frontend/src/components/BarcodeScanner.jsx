import { useEffect, useRef, useState } from "react";
import { Btn, Input } from "@/components/common";
import { Camera, CameraOff, ScanLine } from "lucide-react";

export default function BarcodeScanner({
  onScan,
  disabled = false,
  label = "Scan or enter product code",
  dedupeWindowMs = 1200,
}) {
  const [code, setCode] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const videoRef = useRef(null);
  const controlsRef = useRef(null);
  const busyRef = useRef(false);
  const queueRef = useRef([]);
  const onScanRef = useRef(onScan);
  const lastScanRef = useRef({ code: "", at: 0 });
  onScanRef.current = onScan;

  const submit = (value) => {
    const normalized = value.trim();
    if (!normalized || disabled) return;
    const now = Date.now();
    if (dedupeWindowMs > 0 && lastScanRef.current.code === normalized && now - lastScanRef.current.at < dedupeWindowMs) return;
    lastScanRef.current = { code: normalized, at: now };
    setCode("");
    queueRef.current.push(normalized);
    if (busyRef.current) return;
    busyRef.current = true;
    const processQueue = async () => {
      try {
        while (queueRef.current.length) {
          const next = queueRef.current.shift();
          try {
            await onScanRef.current(next);
          } catch (error) {
            setCameraError(error?.message || "Product scan failed");
          }
        }
      } finally {
        busyRef.current = false;
      }
    };
    void processQueue();
  };

  useEffect(() => {
    if (!cameraOpen || !videoRef.current) return undefined;
    let active = true;
    (async () => {
      try {
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        if (!active) return;
        const reader = new BrowserMultiFormatReader();
        const controlsPromise = reader.decodeFromVideoDevice(undefined, videoRef.current, (result, _error, controls) => {
          if (!active) {
            controls?.stop();
            return;
          }
          if (result) {
            controlsRef.current = controls;
            controls?.stop();
            controlsRef.current = null;
            setCameraOpen(false);
            submit(result.getText());
          }
        });
        controlsPromise.then((controls) => {
          if (active) controlsRef.current = controls;
          else controls.stop();
        }).catch((error) => {
          if (active) setCameraError(error?.message || "Camera could not be started");
        });
      } catch (error) {
        if (active) setCameraError(error?.message || "Camera scanner is unavailable");
      }
    })();
    return () => {
      active = false;
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, [cameraOpen]);

  const toggleCamera = () => {
    setCameraError("");
    setCameraOpen((open) => !open);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-end gap-2">
        <Input
          label={label}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit(code);
            }
          }}
          placeholder="EAN-13, QR or Data Matrix"
          disabled={disabled}
          data-testid="product-scan-input"
        />
        <Btn type="button" variant="outline" onClick={toggleCamera} disabled={disabled} aria-label={cameraOpen ? "Stop camera scanner" : "Open camera scanner"}>
          {cameraOpen ? <CameraOff size={16} /> : <Camera size={16} />}
        </Btn>
        <Btn type="button" variant="outline" onClick={() => submit(code)} disabled={disabled || !code.trim()} aria-label="Find scanned product">
          <ScanLine size={16} />
        </Btn>
      </div>
      {cameraOpen && <video ref={videoRef} className="max-h-64 w-full rounded-lg bg-slate-950 object-contain" muted playsInline />}
      {cameraError && <p className="text-xs text-red-600" role="alert">{cameraError}</p>}
      <p className="text-xs text-slate-400">USB and Bluetooth scanners work as keyboard input. Camera scanning requires browser permission and HTTPS.</p>
    </div>
  );
}
