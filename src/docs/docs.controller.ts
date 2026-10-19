import { Controller, Get, Header, Inject, Res } from "@nestjs/common";
import type { HttpResponse } from "../common/http.js";
import { ApiException } from "../common/errors.js";
import { messageKey } from "../common/i18n/index.js";
import { Public } from "../common/public.decorator.js";
import { openApiDocument } from "./openapi.js";

export const DOCS_ENABLED = Symbol("DOCS_ENABLED");
const SWAGGER_UI_VERSION = "5.34.0";
const SWAGGER_UI_CSS_INTEGRITY =
  "sha384-4c3vsE5f+trhFyHrFrLM1fFGUn531NIaC7dcqEWIJdoRQJ5CkJbSuSCwXLpaS1KF";
const SWAGGER_UI_BUNDLE_INTEGRITY =
  "sha384-9Td7MKiIr2S83E1kZyyVi8KdJw/S8CpAvu0llLyMeg0xq/hDGiZJfVn0fV4llCmK";

@Controller()
export class DocsController {
  constructor(@Inject(DOCS_ENABLED) private readonly docsEnabled: boolean) {}

  @Public()
  @Get("docs-json")
  @Header("Cache-Control", "no-store")
  json() {
    this.ensureEnabled();
    return openApiDocument;
  }

  @Public()
  @Get("docs")
  // Las cabeceras se fijan tras comprobar que la ruta está habilitada: un 404 debe salir como JSON.
  html(@Res({ passthrough: true }) response: HttpResponse): string {
    this.ensureEnabled();
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' https://unpkg.com 'unsafe-inline'; style-src 'self' https://unpkg.com 'unsafe-inline'; img-src 'self' data: https://unpkg.com; connect-src 'self'",
    );
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Operia API</title><link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui.css" integrity="${SWAGGER_UI_CSS_INTEGRITY}" crossorigin="anonymous"></head><body><div id="swagger-ui"></div><script src="https://unpkg.com/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-bundle.js" integrity="${SWAGGER_UI_BUNDLE_INTEGRITY}" crossorigin="anonymous"></script><script>SwaggerUIBundle({url:'/docs-json',dom_id:'#swagger-ui',withCredentials:true})</script></body></html>`;
  }

  private ensureEnabled(): void {
    if (!this.docsEnabled) {
      throw new ApiException("not_found", messageKey("error.notFound"), 404);
    }
  }
}
