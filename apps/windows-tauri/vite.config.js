import { defineConfig } from 'vite';
export default defineConfig({base:'./',clearScreen:false,server:{host:'localhost',port:1420,strictPort:true},build:{outDir:'dist',emptyOutDir:true,target:'es2022'}});
