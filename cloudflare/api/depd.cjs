// Workers forbid dynamic Function compilation. Express only uses depd to warn
// about legacy aliases; keep the original callable and property descriptors.
module.exports=function deprecate(){
 const warn=()=>{};
 warn.function=fn=>fn;
 warn.property=()=>{};
 return warn;
}
