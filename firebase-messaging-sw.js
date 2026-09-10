/* 株価シュミレーター v53 - Firebase Cloud Messaging Service Worker */
importScripts("https://www.gstatic.com/firebasejs/12.2.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.2.1/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey:"AIzaSyBSodaYUF-w3vkQD0QFtS6d7EYs_5ED9As",
  authDomain:"bunka-ca0b7.firebaseapp.com",
  databaseURL:"https://bunka-ca0b7-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:"bunka-ca0b7",
  storageBucket:"bunka-ca0b7.firebasestorage.app",
  messagingSenderId:"412023385867",
  appId:"1:412023385867:web:ceb67271ea36c378bbbc0e"
});

const messaging=firebase.messaging();

messaging.onBackgroundMessage(payload=>{
  const title=payload?.notification?.title||payload?.data?.title||"株価シュミレーター";
  const options={
    body:payload?.notification?.body||payload?.data?.body||"通知があります。",
    tag:payload?.data?.tag||"stock-simulator",
    data:{
      url:payload?.data?.url||"./"
    }
  };

  self.registration.showNotification(title,options);
});

self.addEventListener("notificationclick",event=>{
  event.notification.close();
  const target=event.notification?.data?.url||"./";

  event.waitUntil(
    clients.matchAll({type:"window",includeUncontrolled:true}).then(list=>{
      for(const client of list){
        if("focus" in client){
          client.navigate(target).catch(()=>{});
          return client.focus();
        }
      }
      return clients.openWindow?clients.openWindow(target):undefined;
    })
  );
});
