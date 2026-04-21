export type Priority = 'P1' | 'P2' | 'P3' | 'P4';
export type Language = 'en' | 'de' | 'es';
export interface Ticket {
  id: string; title: string; description: string; priority: Priority;
  status: string; category: string; language: Language;
}
export interface AISolution {
  ticket_id: string; solution: string; confidence: 'high' | 'medium' | 'low';
  steps: string[]; escalate: boolean;
}
