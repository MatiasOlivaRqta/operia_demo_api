import { HttpStatus } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeoService } from "./geo.service.js";

const provinces = {
  provincias: [
    { id: "06", nombre: "Buenos Aires" },
    { id: "02", nombre: "Ciudad Autónoma de Buenos Aires" },
    { id: "14", nombre: "Córdoba" },
  ],
};

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function stubFetch(implementation: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", implementation);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("GeoService", () => {
  it("maps Georef values and sorts names in Spanish", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(provinces));
    stubFetch(fetchMock);
    const service = new GeoService();

    await expect(service.provinces()).resolves.toEqual([
      { id: "06", name: "Buenos Aires" },
      { id: "02", name: "Ciudad Autónoma de Buenos Aires" },
      { id: "14", name: "Córdoba" },
    ]);
    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.searchParams.get("campos")).toBe("id,nombre");
    expect(url.searchParams.get("max")).toBe("100");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) });
  });

  it("maps and sorts localities and serves the second request from cache", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        localidades: [
          { id: "2", nombre: "Zárate", departamento: { nombre: "Zárate" } },
          { id: "1", nombre: "Azul", departamento: { nombre: "Azul" } },
        ],
      }),
    );
    stubFetch(fetchMock);
    const service = new GeoService();
    const expected = [
      { id: "1", name: "Azul", department: "Azul" },
      { id: "2", name: "Zárate", department: "Zárate" },
    ];

    await expect(service.localities("06")).resolves.toEqual(expected);
    await expect(service.localities("06")).resolves.toEqual(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.searchParams.get("provincia")).toBe("06");
    expect(url.searchParams.get("campos")).toBe("id,nombre,departamento.nombre");
    expect(url.searchParams.get("max")).toBe("5000");
  });

  it("returns expired cache data when Georef fails", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(provinces))
      .mockResolvedValueOnce(response({ error: "ignored" }, 500));
    stubFetch(fetchMock);
    const service = new GeoService();
    const cached = await service.provinces();

    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
    await expect(service.provinces()).resolves.toEqual(cached);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns a safe 503 when a request times out without cached data", async () => {
    const abortError = new DOMException("aborted", "AbortError");
    stubFetch(vi.fn().mockRejectedValue(abortError));
    const service = new GeoService();

    await expect(service.provinces()).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      message: "No pudimos obtener el listado de ubicaciones. Probá de nuevo más tarde.",
    });
  });

  it("returns a safe 503 when Georef JSON is invalid", async () => {
    stubFetch(vi.fn().mockResolvedValue(response({ provincias: [{ id: 6 }] })));
    const service = new GeoService();

    await expect(service.provinces()).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      message: "No pudimos obtener el listado de ubicaciones. Probá de nuevo más tarde.",
    });
  });

  it("deduplicates simultaneous requests", async () => {
    let resolveResponse!: (value: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => (resolveResponse = resolve)));
    stubFetch(fetchMock);
    const service = new GeoService();

    const first = service.provinces();
    const second = service.provinces();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveResponse(response(provinces));
    await expect(Promise.all([first, second])).resolves.toEqual([await first, await first]);
  });
});
