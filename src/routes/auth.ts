import { Router } from "express";
import bcrypt from "bcryptjs";
// import jwt from "jsonwebtoken";
import jwt, { Secret, SignOptions } from "jsonwebtoken";
import cookieParser from "cookie-parser";
import { users, User } from "../models/users.js";
import { v4 as uuid } from "uuid";

const router = Router();
router.use(cookieParser());
// register route register a new user
// expects username and password
router.post("/register", async (req, res) => {
  const { username, password } = req.body;
  if ([...users.values()].some(u => u.username === username))
    return res.status(409).json({ error: "Username taken" });
  const passwordHash = await bcrypt.hash(password, 12);
  const newUser: User = { id: uuid(), username, passwordHash };
  users.set(newUser.id, newUser);
  res.status(201).json({ id: newUser.id, username });
});
// login expects username and password and send jwt token in cookie
router.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const user = [...users.values()].find(u => u.username === username);
  if (!user || !(await bcrypt.compare(password, user.passwordHash)))
    return res.status(401).json({ error: "Invalid credentials" });
  const jwtSecret = process.env.JWT_SECRET as jwt.Secret;
  const expiresIn = process.env.JWT_EXPIRES_IN as string;
  const signOpts: SignOptions = {
    expiresIn: parseInt(expiresIn, 10)
  };
  const token = jwt.sign(
    { sub: user.id, username: user.username },
    jwtSecret,
    signOpts
  );
  res
    .cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 1000 * 60 * 60, // match expiresIn
    })
    .json({ message: "Logged in" });
});

export default router;
