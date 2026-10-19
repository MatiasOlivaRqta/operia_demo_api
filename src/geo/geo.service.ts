import { HttpStatus, Injectable } from "@nestjs/common";
import { z } from "zod";
import { env } from "../config/env.js";
import { ApiException } from "../common/errors.js";

const provincesResponseSchema = z.object({
  provincias: z.array(z.object({ id: z.string(), nombre: z.string() })),
});
const localitiesResponseSchema = z.object({
  localidades: z.array(
    z.object({
      id: z.string(),
      nombre: z.string(),
      departamento: z.object({ nombre: z.string() }),
    }),
  ),
});

type Province = { id: string; name: string };
type Locality = { id: string; name: string; department: string };
type CacheEntry<T> = { value: T; fetchedAt: number };

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SERVICE_UNAVAILABLE_MESSAGE = "error.serviceUnavailable" as const;

@Injectable()
export class GeoService {
  private readonly cache = new Map<string, CacheEntry<Province[] | Locality[]>>();
  private readonly inFlight = new Map<string, Promise<Province[] | Locality[]>>();

  provinces(): Promise<Province[]> {
    return this.getCached("provinces", async () => {
      const url = this.url("provincias");
      url.searchParams.set("campos", "id,nombre");
      url.searchParams.set("max", "100");
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("Georef request failed");
      const result = provincesResponseSchema.parse(await response.json());
      return result.provincias
        .map(({ id, nombre }) => ({ id, name: nombre }))
        .sort((a, b) => a.name.localeCompare(b.name, "es"));
    });
  }

  localities(provinceId: string): Promise<Locality[]> {
    return this.getCached(`localities:${provinceId}`, async () => {
      const url = this.url("localidades");
      url.searchParams.set("provincia", provinceId);
      url.searchParams.set("campos", "id,nombre,departamento.nombre");
      url.searchParams.set("max", "5000");
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("Georef request failed");
      const result = localitiesResponseSchema.parse(await response.json());
      return result.localidades
        .map(({ id, nombre, departamento }) => ({
          id,
          name: nombre,
          department: departamento.nombre,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, "es"));
    });
  }

  private url(endpoint: string): URL {
    return new URL(endpoint, `${env.GEOREF_BASE_URL.replace(/\/$/, "")}/`);
  }

  private getCached<T extends Province[] | Locality[]>(
    key: string,
    load: () => Promise<T>,
  ): Promise<T> {
    const entry = this.cache.get(key);
    if (entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS) {
      return Promise.resolve(entry.value as T);
    }

    const pending = this.inFlight.get(key);
    if (pending) return pending as Promise<T>;

    const request = load()
      .then((value) => {
        this.cache.set(key, { value, fetchedAt: Date.now() });
        return value;
      })
      .catch(() => {
        const stale = this.cache.get(key);
        if (stale) return stale.value as T;
        throw new ApiException(
          "unexpected",
          SERVICE_UNAVAILABLE_MESSAGE,
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }
}
