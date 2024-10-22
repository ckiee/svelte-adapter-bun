import { Server } from "SERVER";
import { manifest } from "MANIFEST";
import { build_options, env } from "./env";
import { fileURLToPath } from "bun";
import path from "path";
import sirv from "./sirv";
import { existsSync } from "fs";
import installPolyfills from "./polyfills";
import { get_option, load_page_nodes } from "./crimes"

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));

installPolyfills();

/** @type {import('@sveltejs/kit').Server} */
const server = new Server(manifest);
await server.init({ env: (Bun || process).env });

const xff_depth = parseInt(env("XFF_DEPTH", build_options.xff_depth ?? 1));
const origin = env("ORIGIN", undefined);

const address_header = env("ADDRESS_HEADER", "").toLowerCase();
const protocol_header = env("PROTOCOL_HEADER", "").toLowerCase();
const host_header = env("HOST_HEADER", "host").toLowerCase();
const port_header = env("PORT_HEADER", "").toLowerCase();

/** @param {boolean} assets */
export default function (assets) {
  let handlers = [
    restrictPageEntrypoints,
    assets && serve(path.join(__dirname, "/client"), true),
    assets && serve(path.join(__dirname, "/prerendered")),
    ssr,
  ].filter(Boolean);

  /**@param {Request} req */
  function handler(req) {
    function handle(i) {
      return handlers[i](req, () => {
        if (i < handlers.length) {
          return handle(i + 1);
        } else {
          return new Response(404, { status: 404 });
        }
      });
    }
    return handle(0);
  }

  function defaultAcceptWebsocket(request, server) {
    return server.upgrade(request);
  }

  try {
    const handleWebsocket = server.websocket();
    if (handleWebsocket) {
      return {
        httpserver: async (req, srv) => {
          if (
            req.headers.get("connection")?.toLowerCase().includes("upgrade") &&
            req.headers.get("upgrade")?.toLowerCase() === "websocket"
          ) {
            await (handleWebsocket.upgrade ?? defaultAcceptWebsocket)(req, srv);
            return;
          }
          return handler(req, srv);
        },
        websocket: handleWebsocket,
      };
    }
  } catch (e) {
    console.warn("Fail: websocket handler error:", e);
  }
  return {
    httpserver: handler,
  };
}

async function restrictPageEntrypoints(req, next) {
  // clone and remove trailing slash
  const url = new URL(req.url.toString().replace(/\/$/, ""));

  let pathname = url.pathname;
  if (pathname.indexOf("%") !== -1) {
    try {
      pathname = decodeURIComponent(pathname);
    } catch (err) {
      /* malform uri */
    }
  }

  if (!pathname.startsWith(`/${manifest.appPath}/immutable/nodes/`))
    return next();

  // match something like: /_app/immutable/nodes/4.4zf_eCIQ.js
  //                                  grab this: ^
  const nodeIdx = parseInt(pathname.split("/").pop().split(".")[0], 10);
  // HACK: private field access!
  const route = manifest._.routes.find(route => route.page.leaf == nodeIdx);

  if (!route) return next();

  const nodes = await load_page_nodes(route.page, manifest);

  // If it's possible this request can be denied, go check that..
  if (nodes.some(node => node.server)) {
    /** @type {ServerDataResponse} */
    const fakeUrl = new URL(req.url)
    fakeUrl.pathname = `${route.id}/__data.json`;
    const fakeReq = new Request(fakeUrl, {
      headers: req.headers
    });

    const dataJson = await server.respond(fakeReq, {
      getClientAddress() { return "127.0.0.1"; },
      platform: {
        isBun() {
          return true;
        },
      },
    }).then(r => r.json());

    if (dataJson.type == "redirect")
      return new Response(403, { status: 403 });
  }

  return next();
}

function serve(path, client = false) {
  return (
    existsSync(path) &&
    sirv(path, {
      etag: true,
      gzip: true,
      brotli: true,
      setHeaders:
        client &&
        ((headers, pathname) => {
          if (pathname.startsWith(`/${manifest.appDir}/immutable/`) &&
              !pathname.startsWith(`/${manifest.appDir}/immutable/nodes`)) {
            headers.set("cache-control", "public,max-age=31536000,immutable");
          }
          return headers;
        }),
    })
  );
}

/**@param {Request} request */
function ssr(request) {
  const baseOrigin = origin || get_origin(request.headers);
  const url = request.url.slice(request.url.split("/", 3).join("/").length);
  request = new Request(baseOrigin + url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    mode: request.mode,
    credentials: request.credentials,
    cache: request.cache,
    redirect: request.redirect,
    integrity: request.integrity,
  });

  if (
    address_header &&
    request.headers.get(host_header) !== "127.0.0.1" &&
    !request.headers.has(address_header)
  ) {
    throw new Error(
      `Address header was specified with ${ENV_PREFIX + "ADDRESS_HEADER"
      }=${address_header} but is absent from request`,
    );
  }

  return server.respond(request, {
    getClientAddress() {
      if (address_header && request.headers.get(host_header) !== "127.0.0.1") {
        const value = /** @type {string} */ (request.headers.get(address_header)) || "";

        if (address_header === "x-forwarded-for") {
          const addresses = value.split(",");

          if (xff_depth < 1) {
            throw new Error(`${ENV_PREFIX + "XFF_DEPTH"} must be a positive integer`);
          }

          if (xff_depth > addresses.length) {
            throw new Error(
              `${ENV_PREFIX + "XFF_DEPTH"} is ${xff_depth}, but only found ${addresses.length
              } addresses`,
            );
          }
          return addresses[addresses.length - xff_depth].trim();
        }

        return value;
      }
      return "127.0.0.1";
    },
    platform: {
      isBun() {
        return true;
      },
    },
  });
}

/**
 * @param {Headers} headers
 * @returns {string}
 */
function get_origin(headers) {
  const protocol = (protocol_header && headers.get(protocol_header)) || "https";
  const host = headers.get(host_header);
  const port = port_header && headers[port_header];
  if (port) {
    return `${protocol}://${host}:${port}`;
  } else {
    return `${protocol}://${host}`;
  }
}
