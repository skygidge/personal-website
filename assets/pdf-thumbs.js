/* Lazy PDF-to-thumbnail renderer — loads PDF.js from CDN on demand.
   Usage:  <div data-pdf-thumb="path/to.pdf"></div>
           PdfThumbs.init();
*/
(function(){
  var V='3.11.174';
  var CDN='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'+V;
  var loading=null;

  function load(){
    if(loading)return loading;
    loading=new Promise(function(res,rej){
      if(window.pdfjsLib){res();return;}
      var s=document.createElement('script');
      s.src=CDN+'/pdf.min.js';
      s.onload=function(){
        window.pdfjsLib.GlobalWorkerOptions.workerSrc=CDN+'/pdf.worker.min.js';
        res();
      };
      s.onerror=rej;
      document.head.appendChild(s);
    });
    return loading;
  }

  function render(url,el){
    load().then(function(){
      return window.pdfjsLib.getDocument(url).promise;
    }).then(function(pdf){
      return pdf.getPage(1).then(function(page){
        var vp=page.getViewport({scale:1});
        var scale=280/vp.width;
        var viewport=page.getViewport({scale:scale});
        var canvas=document.createElement('canvas');
        canvas.width=viewport.width;
        canvas.height=viewport.height;
        return page.render({canvasContext:canvas.getContext('2d'),viewport:viewport}).promise.then(function(){
          el.innerHTML='';
          el.appendChild(canvas);
          el.classList.add('thumb-loaded');
          pdf.destroy();
        });
      });
    }).catch(function(){
      el.classList.add('thumb-err');
    });
  }

  function init(){
    var els=document.querySelectorAll('[data-pdf-thumb]');
    if(!els.length)return;
    var io=new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        if(e.isIntersecting){
          render(e.target.getAttribute('data-pdf-thumb'),e.target);
          io.unobserve(e.target);
        }
      });
    },{rootMargin:'300px'});
    els.forEach(function(el){io.observe(el);});
  }

  window.PdfThumbs={init:init};
})();
