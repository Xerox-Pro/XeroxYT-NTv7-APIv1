import appPromise from './node-app';
const app=await appPromise;
const port=Number(process.env.PORT||3000);
app.listen(port,'0.0.0.0',()=>console.log(JSON.stringify({message:'API listening',port})));
