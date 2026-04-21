// src/lib/ai.ts
// Claude AI helper — priority classification & solution generation

import Anthropic from "@anthropic-ai/sdk";
import type { Priority, Language, AISolution, Ticket } from "../types/index.js";

let anthropic: Anthropic | null = null;

function getAI(): Anthropic {
  if (anthropic) return anthropic;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Missing ANTHROPIC_API_KEY in environment");
  anthropic = new Anthropic({ apiKey: key });
  return anthropic;
}

// Classify priority P1–P4 based on ticket content
export async function classifyPriority(
  title: string,
  description: string
): Promise<{ priority: Priority; category: string; reasoning: string }> {
  const ai = getAI();

  const response = await ai.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: `You are an IT Helpdesk triage system. Classify this ticket.

PRIORITY SCALE:
- P1: Critical — system down, security breach, affects all users
- P2: High — major feature broken, affects many users, data risk
- P3: Medium — degraded performance, workaround available
- P4: Low — cosmetic issue, request, minor inconvenience

CATEGORIES: hardware, software, network, security, account, email, printer, other

Ticket Title: ${title}
Description: ${description}

Respond ONLY with valid JSON (no markdown):
{"priority":"P1|P2|P3|P4","category":"string","reasoning":"one sentence"}`,
      },
    ],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  try {
    return JSON.parse(text);
  } catch {
    return { priority: "P3", category: "other", reasoning: "Auto-classified" };
  }
}

// Generate step-by-step solution for a ticket
export async function generateSolution(
  ticket: Ticket,
  language: Language = "en"
): Promise<AISolution> {
  const ai = getAI();

  const langLabel = { en: "English", de: "German", es: "Spanish" }[language];

  const response = await ai.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 600,
    messages: [
      {
        role: "user",
        content: `You are a senior IT support engineer at a Swiss company.
Provide a solution for this IT ticket. Respond in ${langLabel}.

Title: ${ticket.title}
Description: ${ticket.description}
Category: ${ticket.category}
Priority: ${ticket.priority}

Respond ONLY with valid JSON (no markdown):
{
  "solution": "brief summary of solution",
  "confidence": "high|medium|low",
  "steps": ["step 1", "step 2", "step 3"],
  "escalate": false
}

Set escalate=true only if P1 or requires physical access.`,
      },
    ],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  try {
    const parsed = JSON.parse(text);
    return { ticket_id: ticket.id, ...parsed };
  } catch {
    return {
      ticket_id: ticket.id,
      solution: "Manual review required",
      confidence: "low",
      steps: ["Review ticket manually", "Contact requester for more details"],
      escalate: true,
    };
  }
}

// Translate SLA deadline based on priority
export function getSLADeadline(priority: Priority): Date {
  const now = new Date();
  const hoursMap: Record<Priority, number> = {
    P1: 1,    // 1 hour
    P2: 4,    // 4 hours
    P3: 24,   // 1 business day
    P4: 72,   // 3 business days
  };
  now.setHours(now.getHours() + hoursMap[priority]);
  return now;
}
