
import { MongoClient, Db } from "mongodb";

let client : MongoClient;
let db : Db;

// connect to mongoDB database
export const connectDB = async() =>{
  try{
    client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    db = client.db(process.env.DB_NAME);
  }catch(error){
    console.log(process.env.MONGO_URI);
    console.log("MongoDB connection failed. ",error);
    throw new Error("MongoDB connection...");
  }
}

// database object
export const getDB = (): Db =>{
  if(!db){
    throw new Error("Please connect database first.");
  }
  return db;
}

// close database connection
export const closeDB = async ():Promise<void> =>{
  if(!client){
    return null;
  }
  await client.close();
  console.log("MongoDB connection closed");
}