// functions/chat/index.ts — POST /chat — AI Lease Negotiation Chatbot
import express, { type Request, type Response } from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { logger } from "../utils/logger";

const router = express.Router();

const GEMINI_KEY = process.env.GEMINI_API_KEY || "";

// Bounds on what one request can send to Gemini (each call is billed to the server's key).
const MAX_MESSAGE_CHARS = 4000;
const MAX_HISTORY = 30;
const MAX_CONTEXT_CHARS = 20_000;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatBody {
  message: string;
  history?: ChatMessage[];
  contract_context?: Record<string, unknown> | null;
}

const SYSTEM_PROMPT = `You are LeaseGuard AI — an expert lease contract negotiation coach.

Your purpose:
1. Answer questions about lease contracts in plain, friendly language.
2. Provide actionable negotiation tactics and counter-offer strategies.
3. Explain legal and financial terms found in lease agreements.
4. Help users identify red flags, hidden fees, and unfair clauses.
5. Role-play as a negotiation partner so the user can practice.

Rules:
- Keep answers concise (2-4 paragraphs max) unless the user asks for detail.
- Use bullet points for action items.
- If the user shares contract data, reference specific numbers and clauses.
- Always be helpful, never dismissive. If unsure, say so honestly.
- Format responses with markdown for readability.
- When role-playing negotiation, clearly label "You could say:" sections.`;

router.post("/", async (req: Request, res: Response): Promise<void> => {
  const { message, history, contract_context } = req.body as ChatBody;

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  if (message.length > MAX_MESSAGE_CHARS) {
    res.status(400).json({ error: `message must be at most ${MAX_MESSAGE_CHARS} characters` });
    return;
  }

  if (history !== undefined && (
    !Array.isArray(history) ||
    history.length > MAX_HISTORY ||
    !history.every((m) =>
      m && (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string" && m.content.length <= MAX_MESSAGE_CHARS)
  )) {
    res.status(400).json({ error: `history must be at most ${MAX_HISTORY} {role, content} messages` });
    return;
  }

  if (contract_context && JSON.stringify(contract_context).length > MAX_CONTEXT_CHARS) {
    res.status(400).json({ error: "contract_context is too large" });
    return;
  }

  if (!GEMINI_KEY) {
    res.status(503).json({ error: "AI service is not configured" });
    return;
  }

  try {
    const genAI = new GoogleGenerativeAI(GEMINI_KEY);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
    });

    // Build conversation context
    let contextBlock = "";
    if (contract_context) {
      contextBlock = `\n\nThe user has analyzed a lease contract. Here is the extracted data:\n\`\`\`json\n${JSON.stringify(contract_context, null, 2)}\n\`\`\`\nUse this data to give specific, personalized advice.`;
    }

    // Build chat history for multi-turn
    const chatHistory = (history || []).map((msg) => ({
      role: msg.role === "assistant" ? "model" as const : "user" as const,
      parts: [{ text: msg.content }],
    }));

    const chat = model.startChat({
      history: [
        {
          role: "user" as const,
          parts: [{ text: SYSTEM_PROMPT + contextBlock }],
        },
        {
          role: "model" as const,
          parts: [{ text: "Understood! I'm LeaseGuard AI, your lease negotiation coach. I'm ready to help you understand your contract, identify risks, and practice negotiation strategies. What would you like to know?" }],
        },
        ...chatHistory,
      ],
    });

    const result = await chat.sendMessage(message);
    const reply = result.response.text();

    if (!reply) {
      res.status(500).json({ error: "AI returned an empty response" });
      return;
    }

    logger.info("Chat response generated", { messageLen: message.length, replyLen: reply.length });

    res.status(200).json({
      reply,
      tokens_used: reply.length, // approximate
    });
  } catch (err: any) {
    logger.error("Chat endpoint error", { error: err.message });
    res.status(500).json({ error: "Failed to generate response. Please try again." });
  }
});

export default router;
