
import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt, { SignOptions } from "jsonwebtoken";
import cookieParser from "cookie-parser";

import { getDB } from "../config/db.js"

const authCollection = 'users';
const router = Router();
router.use(cookieParser());
// register route register a new user {username,password}
router.post("/register", async (req, res) => {
  const { username, password } = req.body;
  // store data in database
  const db = getDB();
  const users = db.collection(authCollection);
  const userExist = await users.findOne({username: username});
  if(userExist){
    return res.status(409).json({
      error: "Username already taken."
    });
  }
  const passwordHash = await bcrypt.hash(password, 12);
  users.insertOne(
    {
      username: username, 
      email:'email', 
      password: passwordHash, 
      createdAt : new Date()
    }
  ).then((response)=>{
    res.status(201).json(
      {
        id: response.insertedId.toString(),
        username
      }
    );
  }).catch((error)=>{
    console.log("Error in registering user. ",error);
  });
});

// login expects username and password and send jwt token in cookie
router.post("/login", async (req, res) => {
  const { username, password } = req.body;

  const db = getDB();
  const users = db.collection(authCollection);
  users.findOne({username: username})
  .then(async (response)=>{
    if(!(await bcrypt.compare(password,response.password))){
      return res.status(401).json(
        {error: "Invalid credentials"}
      );
    }
    // check 
    const jwtSecret = process.env.JWT_SECRET as jwt.Secret;
    const expiresIn = process.env.JWT_EXPIRES_IN as string;
    const signOpts: SignOptions = {
      expiresIn: parseInt(expiresIn, 10)
    };
    const token = jwt.sign(
      {
        sub: response._id, 
        username: response.username
      },
      jwtSecret,
      signOpts
    );
    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 1000 * 60 * 60, // match expiresIn
    }).json(
      { message: "Logged in" }
    );
  }).catch((error)=>{
    console.log("Error: No user Found. ",error);
  });
});

export default router;
