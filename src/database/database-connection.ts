export const DATABASE_CONNECTION = Symbol("DATABASE_CONNECTION");

export interface DatabaseConnection {
  checkConnection(): Promise<void>;
}
