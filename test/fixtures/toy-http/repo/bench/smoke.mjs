// Smoke oracle: the server starts and answers its health check.
import { once } from "node:events";
import { createApp } from "../server.mjs";

const server = createApp();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
server.close();
process.exit(response.status === 200 ? 0 : 1);
