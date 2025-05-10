import * as esbuild from 'esbuild';

// Bundle mediasoup-client for browser use
await esbuild.build({
  entryPoints: ['./src/mediasoup-entry.js'],
  bundle: true,
  minify: true,
  format: 'esm',
  outfile: './src/public/js/bundles/mediasoup-client.js',
  platform: 'browser',
  target: ['es2020'],
  loader: {
    '.js': 'jsx',
  },
});

console.log('Mediasoup client bundle created successfully!');
