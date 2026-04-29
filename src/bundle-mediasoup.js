import * as esbuild from 'esbuild';

const commonOptions = {
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  loader: {
    '.js': 'jsx',
  },
};

await Promise.all([
  // Bundle mediasoup-client for browser use.
  esbuild.build({
    ...commonOptions,
    entryPoints: ['./src/mediasoup-entry.js'],
    outfile: './src/public/js/bundles/mediasoup-client.js',
  }),
  // Bundle yjs so transcript sync works without external ESM CDN access.
  esbuild.build({
    ...commonOptions,
    entryPoints: ['./src/yjs-entry.js'],
    outfile: './src/public/js/bundles/yjs.js',
  }),
]);

console.log('Browser bundles created successfully!');
