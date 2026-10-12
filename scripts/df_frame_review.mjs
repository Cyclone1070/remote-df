/**
 * df_frame_review.mjs — review every captured client frame.
 *
 * Two jobs:
 *   1. a contact sheet of ALL frames, so the whole zoom can be eyeballed at once
 *   2. per-frame measurements that point at the broken ones, so the manual
 *      review has somewhere to start
 *
 * Corruption shows up as frames whose pixels differ sharply from their
 * neighbours, and as frames containing implausible colours or large flat
 * regions where terrain should be.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DIR = process.argv[2] || '/tmp/zoombug/frames';
const OUT = process.argv[3] || '/tmp/zoombug';

function crc32(b){let c,crc=0xffffffff;for(let n=0;n<b.length;n++){c=(crc^b[n])&0xff;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;crc=c^(crc>>>8);}return (crc^0xffffffff)>>>0;}
const chunk=(t,d)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const td=Buffer.concat([Buffer.from(t,'ascii'),d]);const c=Buffer.alloc(4);c.writeUInt32BE(crc32(td));return Buffer.concat([l,td,c]);};
function writePNG(file,w,h,rgba){
  const st=w*4,raw=Buffer.alloc((st+1)*h);
  for(let y=0;y<h;y++) rgba.copy(raw,y*(st+1)+1,y*st,(y+1)*st);
  const ih=Buffer.alloc(13); ih.writeUInt32BE(w,0); ih.writeUInt32BE(h,4); ih[8]=8; ih[9]=6;
  fs.writeFileSync(file,Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ih),chunk('IDAT',zlib.deflateSync(raw,{level:6})),chunk('IEND',Buffer.alloc(0))]));
}
function readPNG(file){
  const png=fs.readFileSync(file);
  let off=8,idat=[],w=0,h=0,ctype=6;
  while(off<png.length){
    const len=png.readUInt32BE(off);
    const type=png.toString('ascii',off+4,off+8);
    const data=png.subarray(off+8,off+8+len);
    if(type==='IHDR'){w=data.readUInt32BE(0);h=data.readUInt32BE(4);ctype=data[9];}
    if(type==='IDAT')idat.push(data);
    off+=12+len;
  }
  const raw=zlib.inflateSync(Buffer.concat(idat));
  const bpp=ctype===6?4:3, stride=w*bpp;
  const out=Buffer.alloc(w*h*4,255);
  let prev=Buffer.alloc(stride);
  for(let y=0;y<h;y++){
    const ft=raw[y*(stride+1)];
    const line=Buffer.from(raw.subarray(y*(stride+1)+1,y*(stride+1)+1+stride));
    for(let i=0;i<stride;i++){
      const a=i>=bpp?line[i-bpp]:0,b=prev[i],c=i>=bpp?prev[i-bpp]:0;
      let v=line[i];
      if(ft===1)v+=a;else if(ft===2)v+=b;else if(ft===3)v+=(a+b)>>1;
      else if(ft===4){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);v+=(pa<=pb&&pa<=pc)?a:(pb<=pc?b:c);}
      line[i]=v&0xff;
    }
    prev=line;
    for(let x=0;x<w;x++){const s=x*bpp,d=(y*w+x)*4;out[d]=line[s];out[d+1]=line[s+1];out[d+2]=line[s+2];out[d+3]=bpp===4?line[s+3]:255;}
  }
  return {w,h,rgba:out};
}

const files = fs.readdirSync(DIR).filter(f=>f.endsWith('.png')).sort();
console.log('reviewing', files.length, 'frames\n');

const frames = [];
for (const f of files) {
  const p = path.join(DIR, f);
  const { w, h, rgba } = readPNG(p);
  // measurements that separate a good frame from a broken one
  let sum = 0, dark = 0, magenta = 0, unique = new Set();
  const step = 4 * 7;                       // sample every 7th pixel
  let n = 0;
  for (let i = 0; i < rgba.length; i += step) {
    const r = rgba[i], g = rgba[i+1], b = rgba[i+2];
    sum += (r + g + b) / 3;
    if (r < 12 && g < 12 && b < 12) dark++;
    if (r > 200 && g < 60 && b > 200) magenta++;   // the font sheet's key colour
    if (n % 37 === 0) unique.add((r >> 3) + ',' + (g >> 3) + ',' + (b >> 3));
    n++;
  }
  frames.push({ f, w, h, mean: sum / n, darkPct: (100*dark)/n, magentaPct: (100*magenta)/n,
                colors: unique.size, bytes: fs.statSync(p).size });
}

// frame-to-frame difference: corruption makes a frame jump away from its neighbours
function diff(a, b) {
  let d = 0, n = 0;
  for (let i = 0; i < a.length; i += 4 * 11) { d += Math.abs(a[i] - b[i]); n++; }
  return d / n;
}
const px = files.map(f => readPNG(path.join(DIR, f)).rgba);

console.log('frame  mean  dark%  magenta%  colors  sizeKB  diff-from-prev');
let worst = [];
for (let i = 0; i < frames.length; i++) {
  const d = i ? diff(px[i], px[i-1]) : 0;
  frames[i].diff = d;
  if (i) worst.push({ i, d });
  const flag = d > 30 ? '  <== BIG CHANGE' : '';
  console.log(
    String(i).padStart(5),
    frames[i].mean.toFixed(1).padStart(6),
    frames[i].darkPct.toFixed(1).padStart(6),
    frames[i].magentaPct.toFixed(2).padStart(9),
    String(frames[i].colors).padStart(7),
    (frames[i].bytes/1024).toFixed(0).padStart(7),
    d.toFixed(1).padStart(15), flag);
}

worst.sort((a,b)=>b.d-a.d);
console.log('\nlargest frame-to-frame jumps:',
  worst.slice(0,8).map(w=>`#${w.i}(${w.d.toFixed(0)})`).join(' '));

// contact sheet: every frame, small, in order
const TH = 90, TW = 160, COLS = 8;
const rows = Math.ceil(frames.length / COLS);
const W = COLS*TW, H = rows*TH;
const sheet = Buffer.alloc(W*H*4, 0);
frames.forEach((fr, i) => {
  const cx = (i % COLS)*TW, cy = Math.floor(i/COLS)*TH;
  const src = px[i];
  for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
    const sx = Math.floor(x * fr.w / TW), sy = Math.floor(y * fr.h / TH);
    const si = (sy*fr.w + sx)*4, di = ((cy+y)*W + cx+x)*4;
    sheet[di]=src[si]; sheet[di+1]=src[si+1]; sheet[di+2]=src[si+2]; sheet[di+3]=255;
  }
});
writePNG(path.join(OUT,'contact_sheet.png'), W, H, sheet);
console.log(`\ncontact sheet: ${W}x${H} (${frames.length} frames, ${COLS} per row) -> ${OUT}/contact_sheet.png`);
