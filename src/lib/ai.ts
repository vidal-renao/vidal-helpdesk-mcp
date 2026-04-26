// src/lib/ai.ts
import Anthropic from "@anthropic-ai/sdk";
import type { TriageResultWithMeta, TicketPriority, Language } from "../types/index.js";

let anthropic: Anthropic | null = null;

function getAI(): Anthropic {
  if (anthropic) return anthropic;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Missing ANTHROPIC_API_KEY");
  anthropic = new Anthropic({ apiKey: key });
  return anthropic;
}

const SYSTEM_PROMPT = `You are an IT Helpdesk AI Triage Engine for a Swiss SME IT support system.
RESPONSE FORMAT: You MUST respond with ONLY a valid JSON object — no markdown, no explanation.
JSON SCHEMA:
{
  "suggested_category": "Networking" | "Hardware" | "Software" | "Security" | "Billing" | "Other",
  "suggested_priority": "low" | "medium" | "high" | "critical",
  "confidence_score": <number: 0-100>,
  "sentiment": "calm" | "neutral" | "frustrated" | "urgent" | "angry",
  "detected_language": "de" | "fr" | "it" | "en",
  "summary": "<1-2 sentence technical summary>",
  "keywords": ["<keyword>"],
  "smart_response": "<professional reply in the SAME language as the ticket>",
  "estimated_resolution_hours": <integer>,
  "reasoning": "<brief explanation>",
  "contains_pii": <boolean>
}
PRIORITY MATRIX:
- critical: System fully down, data breach, >50 users affected
- high: Core functionality impaired, 10-50 users, revenue at risk
- medium: Partial degradation, <10 users, workaround available
- low: Cosmetic issue, single user, how-to question
CATEGORIES: Networking=VPN/WiFi/DNS, Hardware=devices/printers, Software=apps/OS/crashes, Security=passwords/phishing, Billing=invoices, Other=general
SENTIMENT: angry=ALL CAPS/threats, frustrated=repeated issue, urgent=ASAP/deadline, neutral=matter-of-fact, calm=polite/patient
PRIVACY: contains_pii=true if names/emails/IPs/passwords detected. Never reproduce PII in output.
SMART RESPONSE: 3-5 sentences, same language as ticket, Swiss business standard.`;

export async function triageTicket(title: string, description: string): Promise<TriageResultWithMeta> {
  const ai = getAI();
  const startTime = Date.now();
  const response = await ai.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `TICKET TITLE: ${title}\n\nTICKET DESCRIPTION:\n${description}` }],
  });
  const processingTime = Date.now() - startTime;
  const rawText = response.content[0].type === "text" ? response.content[0].text : "";
  let result: any;
  try {
    result = JSON.parse(rawText);
  } catch {
    const match = rawText.match(/```json\n?([\s\S]*?)\n?```/) || rawText.match(/\{[\s\S]*\}/);
    if (match) result = JSON.parse(match[1] ?? match[0]);
    else throw new Error(`Unparseable AI response: ${rawText.substring(0, 200)}`);
  }
  return { ...result, model_used: response.model, input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens, processing_time_ms: processingTime };
}

export async function generateSolution(
  title: string, description: string, priority: TicketPriority, category: string, language: Language = "en"
): Promise<{ solution: string; steps: string[]; confidence: string; escalate: boolean }> {
  const ai = getAI();
  const langLabel = { en: "English", de: "German", es: "Spanish", fr: "French", it: "Italian" }[language];
  const response = await ai.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 600,
    messages: [{
      role: "user",
      content: `You are a senior IT support engineer at a Swiss company. Respond in ${langLabel}.
Title: ${title}
Description: ${description}
Category: ${category}
Priority: ${priority}
Respond ONLY with valid JSON:
{"solution":"brief summary","confidence":"high|medium|low","steps":["step 1","step 2"],"escalate":false}
Set escalate=true only if priority=critical or requires physical on-site access.`
    }],
  });
  const rawText = response.content[0].type === "text" ? response.content[0].text : "";
  try {
    return JSON.parse(rawText);
  } catch {
    return { solution: "Manual review required", confidence: "low", steps: ["Review manually", "Contact requester"], escalate: true };
  }
}
