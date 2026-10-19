import { z } from "zod";

export const pageSchema = z.coerce.number().int().min(1).default(1);
export const pageSizeSchema = z.coerce.number().int().min(1).max(100).default(25);

export const paginationSchema = z.object({ page: pageSchema, pageSize: pageSizeSchema }).strict();

export function paginate(page: number, pageSize: number): { skip: number; take: number } {
  return { skip: (page - 1) * pageSize, take: pageSize };
}

export type Page<T> = { items: T[]; page: number; pageSize: number; total: number };
