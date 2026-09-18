import { client } from "./pages/client.ts";
import { logo } from "./logo.ts";
import { styles } from "./pages/styles.ts";

export async function handleStyles(): Promise<Response> {
  return new Response(styles, {
    headers: { "content-type": "text/css; charset=utf-8" },
  });
}

export async function handleLogo(): Promise<Response> {
  return new Response(logo, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=86400",
    },
  });
}

export async function handleClient(): Promise<Response> {
  return new Response(client, {
    headers: { "content-type": "text/javascript; charset=utf-8" },
  });
}
