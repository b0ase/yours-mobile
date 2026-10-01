(function(){
  var d=document,root=d.documentElement;root.classList.add('js');
  var reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var hero=d.querySelector('.hero-video');
  if(reduce&&hero){hero.removeAttribute('autoplay');hero.pause();Array.prototype.forEach.call(hero.querySelectorAll('source'),function(s){s.remove()});hero.load();}
  var io='IntersectionObserver' in window;
  var rev=d.querySelectorAll('.reveal');
  if(reduce||!io){rev.forEach(function(e){e.classList.add('in')})}
  else{var ro=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');ro.unobserve(e.target)}})},{rootMargin:'0px 0px -10% 0px'});rev.forEach(function(e){ro.observe(e)})}
  // lazy section videos (and any future .section-loop slots)
  var vids=d.querySelectorAll('.lazy-video,.section-loop');
  if(!reduce&&io){
    var vo=new IntersectionObserver(function(es){es.forEach(function(e){var v=e.target;
      if(e.isIntersecting){if(!v.dataset.loaded){var w=v.dataset.srcWebm;if(w&&v.canPlayType('video/webm; codecs="vp9"')){v.src=w}else{v.src=v.dataset.src}v.dataset.loaded='1'}var p=v.play();if(p&&p.catch)p.catch(function(){})}
      else if(v.dataset.loaded){v.pause()}})},{rootMargin:'200px 0px'});
    vids.forEach(function(v){vo.observe(v)});
  }
  // phone tilt
  var ph=d.getElementById('phone');
  if(ph&&!reduce){var raf=0,px=0,py=0;
    function upd(){raf=0;var r=ph.getBoundingClientRect(),c=(r.top+r.height/2)/window.innerHeight-.5;
      ph.style.setProperty('--rx',(6-c*14+py*-6).toFixed(2)+'deg');ph.style.setProperty('--ry',(-14+px*16).toFixed(2)+'deg')}
    function q(){if(!raf)raf=requestAnimationFrame(upd)}
    window.addEventListener('scroll',q,{passive:true});
    window.addEventListener('pointermove',function(e){if(e.pointerType!=='mouse')return;px=e.clientX/window.innerWidth-.5;py=e.clientY/window.innerHeight-.5;q()},{passive:true});
    upd();}
})();
