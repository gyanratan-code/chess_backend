// load config details
import dotenv from "dotenv";
dotenv.config();

import { NextFunction, Response } from "express";
import jwt from "jsonwebtoken";
import { Request } from "express";

export interface AuthRequest extends Request {
  user?: { sub: string; username: string };
}
// extract jwt token from cookie and then verify token using jwt secret
export function validateJwt(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.cookies.token as string;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as {
      sub: string;
      username: string;
    };
    req.user = payload;
    next();
  } catch(e) {
    console.log(e);
    res.status(401).json({ error: "Invalid token" });
  }
}
