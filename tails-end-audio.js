/* TAIL'S END / DRIPPY RUN — self-contained WebAudio music + SFX engine (no files) */
window.AUDIO=(function(){
  let ac=null,master=null,music=null,sfxG=null,muted=false;
  let playing=false,timer=null,nextT=0,step=0,bar=0,cur=null,curName='';
  function init(){
    if(ac)return;
    const AC=window.AudioContext||window.webkitAudioContext; if(!AC)return;
    ac=new AC();
    master=ac.createGain();master.gain.value=0.9;master.connect(ac.destination);
    music=ac.createGain();music.gain.value=0.0;music.connect(master);
    sfxG=ac.createGain();sfxG.gain.value=0.9;sfxG.connect(master);
  }
  const now=()=>ac?ac.currentTime:0;
  function env(g,t,peak,dur,atk){g.gain.setValueAtTime(0.0001,t);g.gain.exponentialRampToValueAtTime(peak,t+(atk||0.006));g.gain.exponentialRampToValueAtTime(0.0001,t+dur);}
  function tone(freq,dur,type,vol,t,glide,dest){
    if(!ac)return;const o=ac.createOscillator();o.type=type||'sine';o.frequency.setValueAtTime(freq,t);
    if(glide)o.frequency.exponentialRampToValueAtTime(glide,t+dur);
    const g=ac.createGain();env(g,t,vol,dur);o.connect(g);g.connect(dest||sfxG);o.start(t);o.stop(t+dur+0.03);
  }
  function noise(dur,vol,type,freq,t,sweep,dest){
    if(!ac)return;const n=ac.createBufferSource();const buf=ac.createBuffer(1,Math.max(1,ac.sampleRate*dur),ac.sampleRate);
    const d=buf.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1;n.buffer=buf;
    const f=ac.createBiquadFilter();f.type=type||'highpass';f.frequency.setValueAtTime(freq,t);
    if(sweep)f.frequency.exponentialRampToValueAtTime(sweep,t+dur);
    const g=ac.createGain();env(g,t,vol,dur);n.connect(f);f.connect(g);g.connect(dest||sfxG);n.start(t);n.stop(t+dur+0.03);
  }

  /* ============ SFX ============ */
  const sfx={
    click(){tone(420,0.05,'square',0.18,now());},
    select(){const t=now();tone(523,0.07,'square',0.14,t);tone(784,0.1,'square',0.12,t+0.06);},
    dice(){const t=now();for(let i=0;i<3;i++)noise(0.04,0.14,'bandpass',1100+i*450,t+i*0.05);},
    attack(){const t=now();noise(0.12,0.4,'lowpass',1800,t,300);tone(170,0.12,'square',0.22,t,60);},
    crit(){const t=now();noise(0.12,0.45,'lowpass',2200,t,300);[880,1320,1760].forEach((f,i)=>tone(f,0.14,'triangle',0.2,t+0.04+i*0.04));},
    miss(){noise(0.18,0.16,'highpass',3200,now(),700);},
    burn(){const t=now();noise(0.5,0.3,'lowpass',420,t,1900);noise(0.5,0.14,'highpass',1500,t);},
    bark(){const t=now();tone(300,0.1,'sawtooth',0.3,t,150);tone(255,0.12,'sawtooth',0.27,t+0.1,120);},
    brace(){const t=now();tone(880,0.25,'sine',0.22,t);tone(1320,0.25,'sine',0.1,t);},
    hurt(){const t=now();tone(120,0.18,'square',0.28,t,50);noise(0.12,0.2,'lowpass',800,t);},
    levelup(){const t=now();[523,659,784,1046,1318].forEach((f,i)=>tone(f,0.18,'triangle',0.2,t+i*0.08));},
    victory(){const t=now();[523,659,784,1046].forEach((f,i)=>tone(f,0.16,'square',0.2,t+i*0.07));tone(1046,0.4,'triangle',0.18,t+0.3);},
    over(){const t=now();[392,330,262,196].forEach((f,i)=>tone(f,0.3,'triangle',0.2,t+i*0.16));},
    jump(){tone(330,0.14,'square',0.18,now(),640);},
    djump(){tone(440,0.14,'square',0.16,now(),820);},
    walljump(){const t=now();tone(370,0.1,'square',0.16,t,560);noise(0.06,0.1,'highpass',2400,t);},
    land(){const t=now();tone(120,0.07,'sine',0.16,t,60);noise(0.05,0.1,'lowpass',500,t);},
    coin(){const t=now();tone(988,0.06,'square',0.16,t);tone(1319,0.11,'square',0.14,t+0.05);},
    bigcoin(){const t=now();[988,1319,1568].forEach((f,i)=>tone(f,0.09,'square',0.15,t+i*0.05));},
    dash(){noise(0.16,0.2,'bandpass',900,now(),2600);},
    shoot(){const t=now();tone(520,0.09,'sawtooth',0.16,t,170);noise(0.07,0.09,'highpass',1200,t);},
    stomp(){const t=now();tone(180,0.1,'square',0.22,t,70);noise(0.09,0.16,'lowpass',900,t);},
    pound(){const t=now();tone(90,0.22,'sine',0.4,t,40);noise(0.18,0.3,'lowpass',600,t,150);},
    win(){const t=now();[523,659,784,1046,1318,1046].forEach((f,i)=>tone(f,0.18,'square',0.18,t+i*0.1));},
    powerup(){const t=now();[392,523,659,784,1046].forEach((f,i)=>tone(f,0.12,'triangle',0.2,t+i*0.05));},
    gold(){const t=now();[523,659,784,1046,1318,1568,2093].forEach((f,i)=>tone(f,0.14,'triangle',0.18,t+i*0.06));},
    shieldup(){const t=now();tone(660,0.2,'sine',0.2,t,880);tone(990,0.25,'sine',0.12,t+0.05);},
    shieldbreak(){const t=now();noise(0.2,0.3,'highpass',1800,t,400);tone(700,0.16,'square',0.18,t,200);},
    crate(){const t=now();noise(0.12,0.3,'lowpass',900,t,300);noise(0.08,0.2,'bandpass',2000,t+0.03);},
    checkpoint(){const t=now();noise(0.3,0.16,'bandpass',1400,t,600);[659,830,988].forEach((f,i)=>tone(f,0.16,'triangle',0.16,t+0.08+i*0.07));},
    combo(n){tone(700+Math.min(n,8)*120,0.1,'square',0.16,now());},
    whistle(){const t=now();tone(2200,0.7,'sine',0.12,t,700);},
    splash(){const t=now();noise(0.3,0.24,'lowpass',1100,t,300);noise(0.2,0.12,'highpass',2000,t+0.05);},
    roar(){const t=now();noise(0.6,0.4,'lowpass',300,t,900);tone(80,0.5,'sawtooth',0.25,t,55);},
    clank(){const t=now();tone(220,0.08,'square',0.2,t,180);noise(0.1,0.18,'bandpass',3000,t,800);},
    heal(){const t=now();tone(523,0.12,'sine',0.18,t);tone(784,0.2,'sine',0.16,t+0.08);},
    explode(){const t=now();noise(0.5,0.5,'lowpass',1400,t,120);tone(70,0.4,'sine',0.4,t,35);},
    unlock(){const t=now();[659,784,1046].forEach((f,i)=>tone(f,0.14,'triangle',0.18,t+i*0.08));},
  };

  /* ============ MUSIC — multi-song sequencer ============ */
  /* pattern arrays are 16 steps (16th notes); bass/lead are {step:freq} maps; pads = one root per bar */
  const SONGS={
    menu:{bpm:70,kick:[],snr:[],hat:[0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0],hatV:0.04,
      bass:{0:110,8:98},bassW:'sine',bassV:0.16,
      pads:[220,174.61,261.63,196],padV:0.07,
      lead:{0:440,4:523,8:659,12:523},leadW:'triangle',leadV:0.05},
    downtown:{bpm:82,kick:[1,0,0,0,0,0,1,0,0,0,1,0,0,0,0,0],snr:[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0],hat:[1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,1],
      bass:{0:110,3:110,5:130.81,8:101,11:146.83,13:110},bassW:'triangle',bassV:0.28,
      pads:[220,174.61,261.63,196],padV:0.06},
    rooftops:{bpm:102,kick:[1,0,0,0,0,0,0,1,1,0,0,1,0,0,0,0],snr:[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,1],hat:[1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1],
      bass:{0:130.81,3:130.81,6:155.56,8:98,11:98,14:116.54},bassW:'triangle',bassV:0.26,
      pads:[261.63,196,220,174.61],padV:0.055,
      lead:{0:523,2:587,4:659,6:784,10:659,12:587},leadW:'square',leadV:0.05},
    deep:{bpm:74,kick:[1,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0],snr:[0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0],hat:[0,0,1,0,0,0,1,0,0,0,1,0,0,1,0,0],hatV:0.06,
      bass:{0:73.42,7:73.42,10:87.31,13:65.41},bassW:'sine',bassV:0.3,
      pads:[146.83,116.54,174.61,110],padV:0.07},
    scrap:{bpm:94,kick:[1,0,0,1,0,0,1,0,1,0,0,1,0,0,1,0],snr:[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0],hat:[1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1],
      bass:{0:82.41,2:82.41,4:82.41,7:98,9:82.41,12:110,14:98},bassW:'sawtooth',bassV:0.2,
      pads:[164.81,130.81,146.83,164.81],padV:0.05},
    boss:{bpm:124,kick:[1,0,0,0,1,0,0,0,1,0,0,0,1,0,1,0],snr:[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,1],hat:[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],hatV:0.07,
      bass:{0:110,2:110,4:110,6:103.83,8:110,10:110,12:116.54,14:103.83},bassW:'sawtooth',bassV:0.22,
      pads:[110,110,116.54,103.83],padV:0.06,
      lead:{0:880,2:659,4:880,6:1046,8:880,10:659,12:587,14:659},leadW:'square',leadV:0.045},
    neon:{bpm:112,kick:[1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0],snr:[0,0,0,0,1,0,0,1,0,0,0,0,1,0,0,0],hat:[1,1,0,1,1,1,0,1,1,1,0,1,1,1,1,1],hatV:0.08,
      bass:{0:87.31,2:87.31,4:87.31,6:87.31,8:65.41,10:65.41,12:98,14:73.42},bassW:'square',bassV:0.16,
      pads:[174.61,130.81,196,146.83],padV:0.05,
      lead:{0:698,3:880,6:1046,8:932,11:880,14:698},leadW:'square',leadV:0.05},
    final:{bpm:132,kick:[1,0,0,1,1,0,0,0,1,0,0,1,1,0,0,0],snr:[0,0,0,0,1,0,0,0,0,0,0,0,1,0,1,0],hat:[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],hatV:0.08,
      bass:{0:55,2:55,4:58.27,6:55,8:55,10:51.91,12:55,14:65.41},bassW:'sawtooth',bassV:0.24,
      pads:[110,103.83,116.54,110],padV:0.07,
      lead:{0:880,2:1046,4:880,6:1318,8:880,10:1046,12:784,14:659},leadW:'sawtooth',leadV:0.04},
  };
  function kickAt(t){tone(120,0.13,'sine',0.5,t,45,music);}
  function snrAt(t){noise(0.13,0.22,'bandpass',1800,t,null,music);tone(200,0.1,'triangle',0.12,t,null,music);}
  function hatAt(t,v){noise(0.03,v||0.1,'highpass',7000,t,null,music);}
  function schedStep(t){
    const s=cur;if(!s)return;
    if(s.kick&&s.kick[step])kickAt(t);
    if(s.snr&&s.snr[step])snrAt(t);
    if(s.hat&&s.hat[step])hatAt(t,s.hatV);
    if(s.bass&&s.bass[step]!=null)tone(s.bass[step],0.22,s.bassW||'triangle',s.bassV||0.26,t,null,music);
    if(s.lead&&s.lead[step]!=null)tone(s.lead[step],0.16,s.leadW||'square',s.leadV||0.05,t,null,music);
    if(step===0&&s.pads&&s.pads.length){const root=s.pads[bar%s.pads.length];
      tone(root,1.7,'sine',s.padV||0.06,t,null,music);tone(root*1.5,1.7,'sine',(s.padV||0.06)*0.6,t,null,music);}
  }
  function tick(){
    if(!playing)return;
    const stepDur=60/cur.bpm/4;
    while(nextT<now()+0.12){schedStep(nextT);nextT+=stepDur;step=(step+1)%16;if(step===0)bar++;}
    timer=setTimeout(tick,25);
  }
  function playSong(name){
    init();if(!ac)return;
    if(curName===name&&playing)return;
    if(timer)clearTimeout(timer);
    cur=SONGS[name]||SONGS.downtown;curName=name;
    playing=true;step=0;bar=0;nextT=now()+0.08;
    music.gain.cancelScheduledValues(now());
    music.gain.setValueAtTime(Math.max(0.0001,music.gain.value),now());
    music.gain.exponentialRampToValueAtTime(0.13,now()+1.0);
    tick();
  }
  function startMusic(){playSong('downtown');}
  function stopMusic(){if(!ac)return;playing=false;curName='';if(timer)clearTimeout(timer);
    music.gain.cancelScheduledValues(now());music.gain.setValueAtTime(Math.max(0.0001,music.gain.value),now());music.gain.exponentialRampToValueAtTime(0.0001,now()+0.6);}
  function toggleMute(){if(!ac)return false;muted=!muted;master.gain.setTargetAtTime(muted?0:0.9,now(),0.02);return muted;}
  return {init,playSong,startMusic,stopMusic,toggleMute,sfx,isMuted:()=>muted};
})();
