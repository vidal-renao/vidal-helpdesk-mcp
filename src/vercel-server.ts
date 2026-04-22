// src/vercel-server.ts
// Adaptador de Transporte SSE para Despliegue en Vercel
// Vidal Reñao · v1.2.1

import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { server } from "./index.js"; 

const app = express();

/**
 * IMPORTANTE: En entornos Serverless (Vercel), el transporte debe 
 * gestionarse por cada petición para evitar fugas de memoria.
 */
let transport: SSEServerTransport | null = null;

// 1. Health Check & Root Route (Evita el error 404 en el navegador)
app.get("/", (req, res) => {
  res.status(200).json({
    status: "online",
    infrastructure: "Vidal Helpdesk MCP Server",
    version: "1.2.1",
    compliance: "Swiss revDSG Standard",
    endpoints: {
      connection: "/sse",
      messaging: "/messages"
    },
    author: "Vidal Reñao"
  });
});

// 2. Endpoint de Conexión SSE
app.get("/sse", async (req, res) => {
  console.log("🚀 Nueva conexión MCP detectada vía SSE");
  transport = new SSEServerTransport("/messages", res);
  await server.connect(transport);
});

// 3. Endpoint de Mensajería (Post-Messages)
app.post("/messages", async (req, res) => {
  if (!transport) {
    res.status(400).send("No active SSE transport connection");
    return;
  }
  await transport.handlePostMessage(req, res);
});

export default app;