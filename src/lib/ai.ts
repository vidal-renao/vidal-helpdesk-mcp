import Anthropic from "@anthropic-ai/sdk";
import type { Priority, Language, AISolution, Ticket } from "../types/index.js";

// Fix: Modelo configurable desde .env
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest";

const anthropic = new Anthropic({ 
  apiKey: process.env.ANTHROPIC_API_KEY || '' 
});

export async function classifyPriority(
  title: string, 
  description: string
): Promise<{ priority: Priority; category: string; reasoning: string }> {
  const prompt = `You are a Swiss IT Helpdesk triage system. Classify this ticket.
  PRIORITY SCALE:
  - P1: Critical (System down) | P2: High | P3: Medium | P4: Low
  Ticket Title: ${title}
  Description: ${description}
  Respond ONLY with valid JSON: {"priority":"P1|P2|P3|P4","category":"string","reasoning":"one sentence"}`;

  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  try {
    return JSON.parse(text);
  } catch {
    return { priority: "P3", category: "other", reasoning: "Auto-classified due to parse error" };
  }
}

export async function generateSolution(ticket: Ticket, language: Language = "en"): Promise<AISolution> {
  const langLabel = { en: "English", de: "German", es: "Spanish" }[language];
  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 600,
    messages: [{ 
      role: "user", 
      content: `Senior IT Engineer: Provide a technical solution in ${langLabel} for: ${ticket.title}. 
      Respond ONLY with JSON: {"solution":"...","confidence":"high|medium|low","steps":["step 1"],"escalate":false}` 
    }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text : "";
  try {
    const parsed = JSON.parse(text);
    return { ticket_id: ticket.id, ...parsed };
  } catch {
    return { ticket_id: ticket.id, solution: "Manual review required", confidence: "low", steps: [], escalate: true };
  }
}

export function getSLADeadline(priority: Priority): Date {
  const now = new Date();
  const hoursMap: Record<Priority, number> = { P1: 1, P2: 4, P3: 24, P4: 72 };
  now.setHours(now.getHours() + hoursMap[priority]);
  return now;
}