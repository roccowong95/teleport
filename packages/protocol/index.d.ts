export interface Identity { publicKey:string; secretKey:string }
export interface Context { roomId:string; sender:string; recipient:string }
export interface Envelope { v:1; nonce:string; ciphertext:string }
export interface Pairing { v:1; endpoint:string; roomId:string; pairToken:string; ownerPublicKey:string; name:string; expiresAt:number }
export const MAX_TEXT_BYTES:number; export const TTL_MS:number;
export function utf8Length(text:string):number;
export function base64url(bytes:Uint8Array):string;
export function unbase64url(value:string,length?:number):Uint8Array;
export function randomToken():string;
export function generateIdentity():Identity;
export function validEndpoint(input:string):string;
export function encodePairing(pair:Pairing):string;
export function decodePairing(encoded:string,now?:number):Pairing;
export function seal(payload:Record<string,unknown>,context:Context,peerPublicKey:string,secretKey:string):Envelope;
export function open(envelope:Envelope,expected:Context,peerPublicKey:string,secretKey:string):Record<string,unknown>;
export function sas(secretKey:string,peerPublicKey:string,roomId:string):Promise<string>;
export class ReceiverGate { constructor(sessionId:string); accept(message:unknown, options?:{now?:number;paused?:boolean;authorized?:boolean}):{ok:boolean;code?:string}; }
