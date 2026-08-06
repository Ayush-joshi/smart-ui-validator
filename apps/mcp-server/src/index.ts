#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createSmartUiMcpServer } from './server.js';

const server = createSmartUiMcpServer();
await server.connect(new StdioServerTransport());
