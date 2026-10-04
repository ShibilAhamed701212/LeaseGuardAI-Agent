// functions/upload/index.ts — POST /upload
// Uses busboy directly to handle Firebase emulator's body pre-parsing

import express, { type Request, type Response } from "express";
import Busboy from "busboy";
import { v4 as uuidv4 } from "uuid";
import { uploadFile, deleteFile } from "../utils/minioClient";
import { createJob } from "../utils/postgresClient";
import { logger } from "../utils/logger";
import { ALLOWED_MIME, objectNameFor } from "../utils/fileTypes";

const router = express.Router();

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

router.post("/", async (req: Request, res: Response): Promise<void> => {
  let busboy;
  try {
    busboy = Busboy({
      headers: req.headers,
      limits: { fileSize: MAX_FILE_SIZE },
    });
  } catch (err: any) {
    logger.error("Upload rejected: Invalid content type", { message: err.message });
    res.status(400).json({ error: "Invalid content type or missing boundary." });
    return;
  }

  const uploadPromises: Promise<void>[] = [];
  let userId = "";
  let fileUploaded = false;
  let fileError = "";
  let fileName = "";
  let objectName = "";
  let isAborted = false;
  const job_id = uuidv4();

  busboy.on("file", (_fieldname: string, stream: NodeJS.ReadableStream, info: { filename: string; mimeType: string }) => {
    if (isAborted) {
      stream.resume();
      return;
    }
    
    const { filename, mimeType } = info;
    fileName = filename;

    stream.on("limit", () => {
      fileError = "File exceeds 20MB limit";
      isAborted = true;
      stream.resume();
    });

    if (!ALLOWED_MIME.includes(mimeType)) {
      fileError = `Invalid file type: ${mimeType}`;
      isAborted = true;
      stream.resume(); // Drain it to prevent hanging
      
      // Short-circuit processing entirely
      if ("unpipe" in req) req.unpipe(busboy);
      busboy.removeAllListeners();
      req.resume(); // drain the rest of the request
      
      if (!res.headersSent) {
        res.status(400).json({ error: fileError });
      }
      return;
    }

    fileUploaded = true;
    objectName = objectNameFor(job_id, mimeType);

    // Read the entire stream into a Buffer
    const chunks: Buffer[] = [];
    
    stream.on("data", (chunk) => {
      chunks.push(chunk);
    });

    // Pipe directly to MinIO, creating a Promise to await during 'finish'
    const uploadTask = new Promise<void>((resolve, reject) => {
      stream.on("end", async () => {
        if (isAborted) {
          resolve();
          return;
        }
        try {
          const fileBuffer = Buffer.concat(chunks);
          await uploadFile(objectName, fileBuffer, mimeType);
          resolve();
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error("MinIO upload stream error", { err: errMsg, job_id });
          reject(new Error(`File upload failed: ${errMsg}`));
        }
      });
      stream.on("error", (err) => {
        reject(err);
      });
    });
    
    uploadPromises.push(uploadTask);
  });

  busboy.on("field", (fieldname: string, val: string) => {
    if (isAborted) return;
    if (fieldname === "user_id") {
      userId = val;
    }
  });

  busboy.on("finish", async () => {
    if (res.headersSent || isAborted) return;

    try {
      // 1. Wait for all file upload promises to complete to ensure field and file processing is completely settled
      await Promise.all(uploadPromises);

      // 2. Perform validations after MinIO upload and form parsing
      if (fileError) {
        throw new Error(fileError);
      }
      if (!fileUploaded || !fileName) {
        throw new Error("No file uploaded");
      }
      if (!userId || userId.trim() === "") {
        throw new Error("user_id is required");
      }

      // 3. Create job record in PostgreSQL (metadata only)
      await createJob(job_id);

      logger.info("Upload complete", { job_id });

      // Contract: { job_id, status: "uploaded" }
      res.status(200).json({ job_id, status: "uploaded" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "File upload failed";
      logger.error("Upload handler error", { message });
      
      // Cleanup MinIO file if it was uploaded but validation or database creation failed
      if (objectName && fileUploaded) {
        try {
          await deleteFile(objectName);
        } catch (delErr) {
          logger.error("Failed to cleanup orphaned MinIO object", { objectName });
        }
      }

      if (!res.headersSent) {
        const status = message.includes("user_id") || message.includes("uploaded") || message.includes("limit") || message.includes("type") ? 400 : 500;
        res.status(status).json({ error: message });
      }
    }
  });

  busboy.on("error", (err: Error) => {
    if (isAborted) return;
    logger.error("Busboy error", { message: err.message });
    if (!res.headersSent) {
      res.status(500).json({ error: "File upload failed" });
    }
  });

  // Firebase Functions emulator puts the raw body on req.rawBody
  if ((req as any).rawBody) {
    busboy.end((req as any).rawBody);
  } else {
    req.pipe(busboy);
  }
});

export default router;