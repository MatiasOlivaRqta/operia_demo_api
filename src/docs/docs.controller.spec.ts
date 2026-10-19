import { describe, expect, it, vi } from "vitest";
import type { HttpResponse } from "../common/http.js";
import { DocsController } from "./docs.controller.js";

describe("DocsController", () => {
  it("uses a pinned Swagger UI release and SRI for both external assets", () => {
    const response = { setHeader: vi.fn() } as unknown as HttpResponse;
    const html = new DocsController(true).html(response);

    expect(response.setHeader).toHaveBeenCalledWith("Content-Type", "text/html; charset=utf-8");
    expect(html).toContain("swagger-ui-dist@5.34.0");
    expect(html).not.toContain("swagger-ui-dist@5/");
    expect(html).toContain(
      'integrity="sha384-4c3vsE5f+trhFyHrFrLM1fFGUn531NIaC7dcqEWIJdoRQJ5CkJbSuSCwXLpaS1KF" crossorigin="anonymous"',
    );
    expect(html).toContain(
      'integrity="sha384-9Td7MKiIr2S83E1kZyyVi8KdJw/S8CpAvu0llLyMeg0xq/hDGiZJfVn0fV4llCmK" crossorigin="anonymous"',
    );
  });
});
