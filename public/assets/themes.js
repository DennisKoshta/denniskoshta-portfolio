// Shared light/dark theme state. Loaded before CSS to restore preferences without a flash.
(() => {
  const key = 'portfolio-appearance-v3';
  const presets = [
    {id:'mist', name:'Mist', mode:'light', bg:'#edf2f2', accent:'#426b70'},
    {id:'paper', name:'Paper', mode:'light', bg:'#f6f5f1', accent:'#526779'},
    {id:'porcelain', name:'Porcelain', mode:'light', bg:'#f5f7fa', accent:'#456b94'},
    {id:'sand', name:'Sand', mode:'light', bg:'#f2eee6', accent:'#796348'},
    {id:'mono', name:'Monochrome', mode:'light', bg:'#f3f3f3', accent:'#555555'},
    {id:'midnight', name:'Midnight', mode:'dark', bg:'#0c0d0e', accent:'#a8bad2'},
    {id:'graphite', name:'Graphite', mode:'dark', bg:'#202326', accent:'#adc6c8'},
    {id:'ink', name:'Ink', mode:'dark', bg:'#181c22', accent:'#a8bad2'},
    {id:'night-mist', name:'Night mist', mode:'dark', bg:'#1c272a', accent:'#a8cbcc'},
    {id:'charcoal', name:'Charcoal', mode:'dark', bg:'#252525', accent:'#c5c5c5'},
    {id:'warm-gray', name:'Warm gray', mode:'dark', bg:'#272522', accent:'#cdbda7'},
    {id:'slate', name:'Blue slate', mode:'dark', bg:'#242e40', accent:'#9acdf7'}
  ];
  const hex = value => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);
  const rgb = color => color.slice(1).match(/../g).map(v => parseInt(v,16));
  const mix = (a,b,t) => '#' + rgb(a).map((v,i) => Math.round(v*(1-t)+rgb(b)[i]*t).toString(16).padStart(2,'0')).join('');
  const luminance = color => rgb(color).map(v => {v/=255; return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
  const contrast = (a,b) => {const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
  function colors(theme) {
    const bg=theme.bg, dark=luminance(bg)<.179;
    const ink=dark?'#ffffff':'#000000';
    const surface=mix(bg,dark&&luminance(bg)>.12?'#000000':'#ffffff',dark?.065:.6);
    const field=mix(bg,dark?'#000000':'#ffffff',dark?.12:.35);
    const hover=mix(surface,dark?'#000000':'#ffffff',.04);
    const backgrounds=[bg,surface,field,hover];
    function readable(color,minimum=4.5) {
      for(let i=0;i<=100;i++){
        const candidate=mix(color,ink,i/100);
        if(backgrounds.every(b=>contrast(candidate,b)>=minimum))return candidate;
      }
      return ink;
    }
    const link=readable(theme.accent), muted=readable(mix(ink,bg,.37));
    const selection=link;
    return {
      'bg':bg,'text':readable(mix(ink,bg,.13)),'heading':readable(dark?'#f5f7fa':'#15202a'),'accent':link,'link':link,'muted':muted,
      'rule':mix(bg,ink,.22),'surface':surface,'field':field,'field-border':readable(mix(bg,ink,.4),3.1),
      'selection':selection,'selection-text':contrast('#ffffff',selection)>contrast('#15202a',selection)?'#ffffff':'#15202a',
      'shadow':`0 8px 24px ${dark?'#09142229':'#18232d0b'}`,
      'shadow-hover':`0 12px 26px ${dark?'#09142240':'#18232d16'}`,
      'research':link,'products':link,'studio':link,'top-wash':bg,
      'nav-hover':surface,'nav-active':hover,'nav-border':mix(bg,theme.accent,.2),
      'dot':mix(bg,theme.accent,.3),'portrait-border':mix(bg,ink,.25),'portrait-offset':mix(bg,theme.accent,.12),
      'tile-border':mix(bg,ink,.16),'tile-highlight':dark?'#ffffff09':'#ffffff99','tile-hover':hover,
      'writing-rule':mix(bg,theme.accent,.45),'side-bg':surface,
      'scheme':dark?'dark':'light'
    };
  }
  const modeOf = theme => luminance(theme.bg)<.179?'dark':'light';
  const valid = theme => theme && hex(theme.bg) && hex(theme.accent);
  const defaults = {light:presets[0],dark:presets.find(p=>p.id==='midnight')};
  const state = {mode:'light',light:{...defaults.light},dark:{...defaults.dark}};
  try {
    const stored=JSON.parse(localStorage.getItem(key));
    if(stored){
      for(const mode of ['light','dark'])if(valid(stored[mode])&&modeOf(stored[mode])===mode)state[mode]=stored[mode];
      if(['light','dark'].includes(stored.mode))state.mode=stored.mode;
    }else{
      // Retire experimental palettes while retaining the visitor's chosen mode.
      const previous=JSON.parse(localStorage.getItem('portfolio-appearance-v2'));
      if(previous&&['light','dark'].includes(previous.mode))state.mode=previous.mode;
      else {const legacy=JSON.parse(localStorage.getItem('portfolio-theme-preview-v1'));if(valid(legacy))state.mode=modeOf(legacy);}
    }
  }catch{}
  let current;
  function apply(theme,persist=true) {
    if(!valid(theme))return;
    const mode=modeOf(theme);
    const preset=presets.find(p=>p.bg.toLowerCase()===theme.bg.toLowerCase()&&p.accent.toLowerCase()===theme.accent.toLowerCase());
    current={id:preset?.id||'custom',name:preset?.name||'Custom',mode,bg:theme.bg.toLowerCase(),accent:theme.accent.toLowerCase()};
    state.mode=mode;state[mode]={...current};
    const tokens=colors(current),root=document.documentElement;
    for(const [name,value] of Object.entries(tokens))if(name!=='scheme')root.style.setProperty('--'+name,value);
    root.style.colorScheme=tokens.scheme;
    root.dataset.theme=current.id;root.dataset.mode=mode;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content',current.bg);
    if(persist)try{localStorage.setItem(key,JSON.stringify(state));localStorage.removeItem('portfolio-theme-preview-v1');localStorage.removeItem('portfolio-appearance-v2');}catch{}
    if(typeof window.dispatchEvent==='function')window.dispatchEvent(new Event('portfolio-theme-change'));
  }
  apply(state[state.mode],false);
  window.portfolioTheme={
    presets,colors,get current(){return {...current};},apply,
    setMode(mode){if(['light','dark'].includes(mode))apply(state[mode]);},
    toggleMode(){this.setMode(state.mode==='light'?'dark':'light');},
    reset(){apply(defaults[state.mode]);}
  };
})();
