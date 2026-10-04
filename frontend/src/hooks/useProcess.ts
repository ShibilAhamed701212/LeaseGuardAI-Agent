import { useState, useCallback, useRef, useEffect } from "react";
import { processDocument, getStatus, type JobStatus } from "../services/api";
import { friendlyError, trackError, trackUserAction } from "../utils/helpers";
import type { AiConfig } from "../components/upload/ModelSelector";

interface UseProcessReturn {
  trigger:  (job_id: string, ocr: string, ai: string, config?: AiConfig) => Promise<void>;
  status:   JobStatus | null;
  loading:  boolean;
  error:    string | null;
}

const POLL_MS   = 2000;
const MAX_POLLS = 300; // 10 minutes max for complex leases

export function useProcess(onComplete: (jobId: string) => void): UseProcessReturn {
  const [status,  setStatus]  = useState<JobStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = () => {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
  };

  // Stop polling if the page unmounts mid-job.
  useEffect(() => stop, []);

  const trigger = useCallback(async (job_id: string, ocr: string, ai: string, config?: AiConfig) => {
    setLoading(true);
    setError(null);
    trackUserAction('process_start', { job_id, ocr, ai });
    try {
      await processDocument(job_id, ocr, ai, config);
      setStatus("processing");
      stop();
      let polls = 0;
      timer.current = setInterval(async () => {
        polls++;
        try {
          const { status: s } = await getStatus(job_id);
          setStatus(s);
          if (s === "completed") { 
            stop(); 
            setLoading(false); 
            trackUserAction('process_complete', { job_id });
            onComplete(job_id); 
          }
          if (s === "failed")    { 
            stop(); 
            setLoading(false); 
            setError("Processing failed on server.");
            trackError("Processing failed", undefined, { job_id }, 'useProcess');
          }
          if (polls >= MAX_POLLS){ 
            stop(); 
            setLoading(false); 
            setError("Processing timed out. Please retry.");
            trackError("Processing timeout", undefined, { job_id, polls }, 'useProcess');
          }
        } catch (e) { 
          stop(); 
          setLoading(false); 
          const msg = friendlyError(e);
          setError(msg);
          trackError(msg, undefined, { job_id }, 'useProcess');
        }
      }, POLL_MS);
    } catch (err) {
      setLoading(false);
      const msg = friendlyError(err);
      setError(msg);
      trackError(msg, undefined, { job_id, ocr, ai }, 'useProcess');
    }
  }, [onComplete]);

  return { trigger, status, loading, error };
}