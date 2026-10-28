#!/usr/bin/env node
// Servidor MCP (stdio) de Radar Urbano: consultar un numero y preparar un reporte.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { consultarNumero, prepararReporte, ToolError } from './tools.mjs';

const server = new McpServer({ name: 'radar-urbano', version: '1.0.0' });

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (err) => ({
  isError: true,
  content: [{ type: 'text', text: err instanceof ToolError ? err.message : 'Error inesperado al usar Radar Urbano.' }],
});

server.registerTool(
  'consultar_numero',
  {
    title: 'Consultar un numero en Radar Urbano',
    description:
      'Indica cuantas personas distintas reportaron un numero de telefono mexicano como fraude o molestia. Solo lectura. ' +
      'Los reportes son de usuarios y no estan verificados; "sin reportes" NO significa que el numero sea seguro, dilo asi.',
    inputSchema: { numero: z.string().describe('Numero de telefono, con o sin lada; se ignoran espacios y guiones') },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ numero }) => {
    try {
      return ok(await consultarNumero(numero));
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  'preparar_reporte',
  {
    title: 'Preparar un reporte para que la persona lo confirme',
    description:
      'Devuelve un enlace a Radar Urbano con el formulario de reporte prellenado. NO envia nada: la persona usuaria debe abrirlo, ' +
      'revisarlo y enviarlo. Usalo solo para hechos que ella vivio o presencio (fraude por telefono, robo, asalto). ' +
      'No lo uses para senalar a una persona por nombre.',
    inputSchema: {
      descripcion: z.string().describe('Que paso, entre 10 y 1000 caracteres'),
      telefono: z.string().optional().describe('Numero involucrado, si lo hay'),
      zona: z.string().optional().describe('Colonia o zona donde ocurrio, si se conoce (obligatoria si no hay telefono)'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (args) => {
    try {
      return ok(prepararReporte(args));
    } catch (err) {
      return fail(err);
    }
  }
);

await server.connect(new StdioServerTransport());
