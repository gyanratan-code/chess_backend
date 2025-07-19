export interface User {
  id: string;
  username: string;
  passwordHash: string
}
export const users = new Map<string, User>();