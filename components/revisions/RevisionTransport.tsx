"use client";
import { createContext, useContext } from 'react';
export const RevisionTransportContext = createContext<{fetch:typeof fetch; revision:boolean}>({fetch:(...args)=>globalThis.fetch(...args),revision:false});
export function useRevisionTransport(){return useContext(RevisionTransportContext);}
