import { getDB } from "../config/db.js";
import { Collection,Document } from "mongodb";

export interface User extends Document {
  username: string;
  email: string;
  password: string;
  createdAt: Date;
}

export async function initUserModel():Promise<Collection<User>> {
  const db = getDB();
  const collectionName = 'users';
  // check for existence of collection
  const existCollection = await db.listCollections({name: collectionName}).hasNext();
  if(!existCollection){
    // create collection
    await db.createCollection(collectionName,{
      validator:{
        $jsonschema:{
          bsonType: 'object',
          required: ['username', 'email', 'password', 'createdAt'],
          properties: {
            username: { bsonType: 'string', minLength: 3 },
            email: { bsonType: 'string' },
            password: { bsonType: 'string' },
            createdAt: { bsonType: 'date' }
          }
        }
      }
    });
  }

  const users:Collection<User> = db.collection(collectionName);
  await users.createIndex({ username : 1}, { unique: true});
  return users;
}