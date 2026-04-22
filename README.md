# 🇨🇭 Vidal Helpdesk MCP Server
> **Enterprise-Grade AI-Powered SaaS Infrastructure for Swiss SMEs**
> *Model Context Protocol (MCP) implementation for autonomous ticket orchestration, built with Supabase and Anthropic Claude AI under Swiss revDSG standards.*

![Version](https://img.shields.io/badge/version-1.2.1-0A84FF?style=for-the-badge)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript)
![Supabase](https://img.shields.io/badge/Supabase-Isolated_Schema-3ECF8E?style=for-the-badge&logo=supabase)
![Compliance](https://img.shields.io/badge/Compliance-Swiss_revDSG-DA291C?style=for-the-badge)
![Architecture](https://img.shields.io/badge/Architecture-Clean_Layers-007ACC?style=for-the-badge)

---

## 1. Executive Summary

`vidal-helpdesk` es una infraestructura **AI-Native** de grado de producción diseñada para transformar el soporte técnico en una operación autónoma. Este servidor permite que Claude Desktop actúe como un orquestador de soporte, gestionando el ciclo de vida de los incidentes directamente en lenguaje natural.

Construido para empresas que requieren **soberanía de datos absoluta**, el sistema utiliza transporte `stdio` local y una capa de persistencia en Supabase (preferiblemente regiones suizas como Zúrich), garantizando que el plano de datos permanezca bajo control del operador.

**Valor de Negocio:**
- **MTTR (Mean Time To Repair):** Reducción drástica mediante triaje automático y sugerencias de resolución instantáneas.
- **Data Locality:** Cumplimiento nativo con la **Federal Act on Data Protection (revDSG)**.
- **Conversational BI:** Capacidad de consultar métricas de salud de infraestructura mediante lenguaje natural.

---

## 2. System Architecture

El servidor implementa un patrón de **Clean Architecture**, aislando el protocolo de transporte de la lógica de negocio y la capa de datos.

```text
┌──────────────────────────┐          JSON-RPC          ┌──────────────────────────┐
│     Claude Desktop       │   ◄────────────────────►   │    Vidal MCP Server      │
│      (MCP Client)        │           stdio            │      (Node.ts 20)        │
└──────────────────────────┘                            └────────────┬─────────────┘
                                                                     │ service_role
                                                                     ▼
                                       ┌───────────────────────────────────────────┐
                                       │         Supabase Postgres Cluster         │
                                       │   (Isolated Schema: 'helpdesk' + RLS)     │
                                       └──────────────┬────────────────────┬───────┘
                                                      │                    │
                                       ┌──────────────┴──────┐      ┌──────┴───────┐
                                       │  Anthropic API      │      │  Audit Log   │
                                       │  (Triage & NLU)     │      │  (Traceable) │
                                       └─────────────────────┘      └──────────────┘

                                       


                                       3. Tool Inventory (Enterprise v1.2.1)ToolCapabilityAccessLogiccreate_ticketAI-Driven TriageWriteClasificación P1-P4 + SLA Calculation.list_ticketsContext AwarenessReadFiltrado avanzado sobre esquema aislado.get_ticket_statusSLA MonitoringReadEvaluación de Breaches en tiempo real.prioritize_incidentRecursive ReasoningWriteAjuste dinámico de criticidad según contexto.suggest_solutionResolution EngineReadSugerencias multilingües (ES/DE/EN).count_ticketsOperational BIReadAgregación de datos y analítica de carga.generate_reportExecutive AuditReadHealth Score de infraestructura y métricas SLA.


                                       4. Engineering Battle — Real Deployment Lessons (Windows)
Documentación de fricciones técnicas resueltas durante el despliegue en entornos Windows 11:

4.1 Claude Sandbox (Microsoft Store)
La versión MSIX corre en un AppContainer. La configuración debe residir en:
%LOCALAPPDATA%\Packages\Anthropic.ClaudeForWindows_...\LocalCache\Roaming\Claude\claude_desktop_config.json

4.2 JSON Path Escaping
Los paths en el config deben usar doble backslash (\\) o forward slash (/) según RFC 8259 para evitar errores de parseo:
"args": ["C:/Users/Vidal/Projects/vidal-helpdesk/dist/index.js"]

4.3 Gestión de Procesos Huérfanos
Al cerrar la ventana, Claude permanece en el tray y mantiene el proceso node vivo. Para aplicar cambios de código, es imperativo matar el proceso manualmente:
Stop-Process -Name "node" -Force

5. Compliance Notes (revDSG / Swiss)
Data Residency: Todo el contenido reside en Supabase. Se recomienda la región eu-central-2 (Zúrich).

AI Disclosure: Las herramientas de IA deben declararse en el aviso de privacidad como "procesamiento automatizado mediante Anthropic".

Audit Trail: Las columnas created_at / updated_at junto con el ai_summary garantizan la trazabilidad exigida por el principio de transparencia.

6. License & Contact
Proprietary — © 2026 Vidal Reñao Lopelo.
Fullstack Developer | AI-Powered SaaS Infrastructure Specialist
Basel, Switzerland · vidal-pro-portfolio.vercel.app