const CSS_PATH = new URL("./pages/styles.css", import.meta.url);
const CLIENT_PATH = new URL("./pages/client.js", import.meta.url);
const LOGO_PATH = new URL("../../logo.png", import.meta.url);

export async function handleStyles(): Promise<Response> {
  try {
    const css = await Deno.readTextFile(CSS_PATH);
    return new Response(css, {
      headers: { "content-type": "text/css; charset=utf-8" },
    });
  } catch {
    return new Response("/* styles missing */", {
      status: 404,
      headers: { "content-type": "text/css" },
    });
  }
}

export async function handleLogo(): Promise<Response> {
  try {
    const bytes = await Deno.readFile(LOGO_PATH);
    return new Response(bytes, {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=86400",
      },
    });
  } catch {
    return new Response("", { status: 404 });
  }
}

export async function handleClient(): Promise<Response> {
  try {
    const js = await Deno.readTextFile(CLIENT_PATH);
    return new Response(js, {
      headers: { "content-type": "text/javascript; charset=utf-8" },
    });
  } catch {
    return new Response("/* client missing */", {
      status: 404,
      headers: { "content-type": "text/javascript" },
    });
  }
}
