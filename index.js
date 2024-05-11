'use strict';
var http = require('http');
const gpio = require('array-gpio');
var BME280 = require('bme280-sensor');
const {SerialPort} = require('serialport');
var fs = require('fs');
var path = require('path');
var mime=require('mime');

var OFF = false;
var ON = true;
var RELAY_ON = OFF; // inverse logic on relayboard
var RELAY_OFF = ON;

const gpioArray = [
  ["2", "3"],
  ["3", "5"],
  ["4", "7"],
  ["17", "11"],
  ["27", "13"],
  ["22", "15"],
  ["10", "19"],
  ["9", "21"],
  ["11", "23"],
  ["5", "29"],
  ["6", "31"],
  ["13", "33"],
  ["19", "35"],
  ["26", "37"],
  ["14", "8"],
  ["15", "10"],
  ["18", "12"],
  ["23", "16"],
  ["24", "18"],
  ["25", "22"],
  ["8", "24"],
  ["7", "26"],
  ["12", "32"],
  ["16", "36"],
  ["20", "38"],
  ["21", "40"]
];

const gpioMap = new Map(gpioArray);


var platform, Accessory, Service, Characteristic, AirPressure, UUIDGen, zones, furnaceLog, sensorLog;


var zones={
  "1" : {
      "relayPinHeat" : 1,
      "sensors" : {
          "AE":{
              "location" : "snug",
              "source" : "serial",
              "extras" : "batt"
          },
          "AF":{
              "location" : "living",
              "source" : "serial",
              "extras" : "batt"
          }
        }
  },
  "2" : {
      "relayPinHeat" : 2,
      "relayPinCool" : 4,
      "relayPinFan" : 5,
      "sensors" : {
          "AA":{
              "location" : "master",
              "source" : "serial",
              "extras" : "batt"
          },
          "AB":{
              "location" : "tess",
              "source" : "serial",
              "extras" : "batt"
          },
          "AC":{
              "location" : "kate",
              "source" : "serial",
              "extras" : "batt"
          }
        }
  },
  "3" : {
    "relayPinHeat" : 3,
    "sensors" : {
        "AH":{
            "location" : "addition",
            "source" : "serial",
            "extras" : "batt"
        }
      }
  } 
};
module.exports = function(homebridge) {
  console.log("homebridge API version: " + homebridge.version);
  Accessory = homebridge.platformAccessory;
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;
  
  AirPressure = function() {
        Characteristic.call(this, 'Air Pressure', 'E863F10F-079E-48FF-8F27-9C2605A29F52');
        this.setProps({
          format: Characteristic.Formats.UINT16,
          unit: 'hPa',
          minValue: 700,
          maxValue: 1100,
          minStep: 1,
          perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
        });
        //this.value = this.getDefaultValue();
  };
  AirPressure.prototype=Object.create(Characteristic.prototype);
  
  // registerPlatform(pluginName, platformName, constructor, dynamic), dynamic must be true
  homebridge.registerPlatform("homebridge-multizone-thermostat", "MultiZonePlatform", MultiZonePlatform, true);
};
function MultiZonePlatform(log, config, api) {
  log("MultiZonePlatform Init");
  platform = this;
  this.log = log;
  this.config = config;
  this.accessories = [];
  furnaceLog=[];
  sensorLog=[];
  this.relayPins = config.relayPins || [25,24,23,22,27,17]
  this.zones = config.zones || zones;
  this.sensors=[];
  this.sensorCheckMilliseconds = config.sensorCheckMilliseconds || 60000;
  this.temperatureDisplayUnits = config.temperatureDisplayUnits || 1;
  this.minOnOffTime = config.minOnOffTime || 300000;
  this.startDelay = config.startDelay || 10000;
  this.serverPort = config.serverPort || 3000;
  this.serialCfg = config.serialCfg || {path : '/dev/serial0', baudRate : 9600 };
  this.hasBME280 = config.hasBME280;
  this.remoteBME280URL = config.remoteBME280URL;
  this.accuweatherURL = config.accuweatherURL;
  this.alarmTemp = config.alarmTemp;
  this.alarmKey = config.alarmKey;
  this.alarmSecret = config.alarmSecret;
  this.alarmTopic = config.alarmTopic; 
  this.reasonableTemperatures = config.reasonableTemperatures;
  this.cpuTemp=20.0;
  this.weatherData={'condition':'','temp':''};
  this.setupGPIO();
  this.startup();
  if (api) {
      this.api = api;
      this.api.on('didFinishLaunching', function() {
        platform.log("DidFinishLaunching");
        platform.startUI();
        platform.startSensorLoops();
        platform.startControlLoop();      
      }.bind(this));
      this.api.on('shutdown', function() {
        platform.shutdown();     
      }.bind(this));
  }else{
    platform.startUI();
    platform.startSensorLoops();
    platform.startControlLoop();
  }
}
MultiZonePlatform.prototype.startup=function(){
  var status={};
  try{
    platform.log("startup");
    var filePath="status.json";
    status=JSON.parse(fs.readFileSync(filePath));
    platform.log(filePath, status.furnaceLog.length);
    if(platform.hasBME280){
      platform.bme280 = new BME280({i2cBusNo:1, i2cAddress: 0x76});
      platform.bme280.init().then(() => {
        platform.log("BME280 initialization successful");
      });
    }
  }catch(err){
    platform.log("cannot load status.json");
  }
  furnaceLog=status.furnaceLog || [];
  sensorLog=status.sensorLog || [];
  // Does this preserve status???
  //platform.zones=status.zones;
};
MultiZonePlatform.prototype.shutdown=function(){
  var status=this.getStatus();
  platform.log("shutdown");
  var filePath="status.json";
  fs.writeFileSync(filePath,status);
};
MultiZonePlatform.prototype.startUI=function() {
  this.requestServer = http.createServer(function (request, response) {
    //platform.log("serving",request.url);
    if (request.url.toLowerCase().indexOf("/status") == 0) {
      var simple=(request.url.length>7);
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/json');
      response.end(platform.getStatus(simple));
    }
    else if (request.url === "/" || request.url === "" || request.url ==="/simple") {
      this.returnFileContents("/index.html", response);
    }
    else if (request.url.indexOf("/set/") == 0) {
      var parts = request.url.split("/");
      if (parts.length > 4) {
        var z = parts[2];
        var HCState= platform.systemStateValue(parts[3]);
        var setVal = parts[4];
        this.setTemperature(z, HCState, setVal);
        response.statusCode = 200;
      }else{
        response.statusCode = 500;
      }
      response.end();
    }
    else if (request.url.indexOf("?") > 0) {
      let params = new URLSearchParams(request.url.split("?")[1]);
      let deviceid = params.get('deviceid');
      if(deviceid){
        var deviceData={};
        params.forEach( (value, name, searchParams) => {
          if(name != 'deviceid')deviceData[name]=value;
        });
        // eg /sensor?deviceid=bmr&temp=30.1&press=999.99&humid=45.1&batt=100.0
        platform.updateSensorData(deviceid, deviceData);
        response.end("UPDATED")
      }else{
        response.end("NO deviceid specified");
      }  
    }
    else
      this.returnFileContents(request.url, response);
  }.bind(this));
  this.requestServer.listen(platform.serverPort, function () {
    platform.log("Server Listening on port", platform.serverPort);
  });
};
MultiZonePlatform.prototype.setupGPIO=function() {
  try{
        //translate relayPins from BCM to physical
      for (var pin in platform.relayPins) {
        platform.relayPins[pin]=gpioMap.get(platform.relayPins[pin]);
      }
      platform.log("setup pins", platform.relayPins, "for relay");
      platform.relayControl = gpio.setOutput({pin:platform.relayPins});
  }
  catch (err) {
    platform.log('error ln253', JSON.stringify(err));
  }
};
MultiZonePlatform.prototype.writeGPIO=function(pin ,val){
  //platform.log("writeGPIO", platform.relayPins[ Number(pin) - 1 ], val, "relay", pin);
  if(val) platform.relayControl[ Number(pin) - 1 ].on;
  else platform.relayControl[ Number(pin) - 1 ].off;
};
MultiZonePlatform.prototype.sendSNSMessage=function(message){
  var AWS = require('aws-sdk'); 
  AWS.config.update({region: 'us-east-1'}); 
  var sns=new AWS.SNS(
    {accessKeyId:platform.alarmKey,
    secretAccessKey:platform.alarmSecret});
  var params = {
    Message: message,
    TopicArn: platform.alarmTopic
  };
  sns.publish(params, function(err, data) {
    if (err) platform.log(err, err.stack);
  });
};
MultiZonePlatform.prototype.updateGPIO=function(zone, HeatCoolMode ,val){
  try{
    //platform.log("updateGPIO", "zone", zone , platform.systemStateName( HeatCoolMode), val)
    if(HeatCoolMode==Characteristic.CurrentHeatingCoolingState.OFF){
      if(platform.zones[zone].relayPinCool)platform.writeGPIO(platform.zones[zone].relayPinCool,RELAY_OFF);
      if(platform.zones[zone].relayPinHeat)platform.writeGPIO(platform.zones[zone].relayPinHeat,RELAY_OFF);
      if(platform.zones[zone].relayPinFan)platform.writeGPIO(platform.zones[zone].relayPinFan,RELAY_OFF);
    }else if(HeatCoolMode==Characteristic.CurrentHeatingCoolingState.HEAT){
      if(platform.zones[zone].relayPinCool)platform.writeGPIO(platform.zones[zone].relayPinCool,RELAY_OFF);
      if(platform.zones[zone].relayPinHeat)platform.writeGPIO(platform.zones[zone].relayPinHeat,val?RELAY_ON:RELAY_OFF);
    }else if(HeatCoolMode==Characteristic.CurrentHeatingCoolingState.COOL){
      if(platform.zones[zone].relayPinCool)platform.writeGPIO(platform.zones[zone].relayPinCool,val?RELAY_ON:RELAY_OFF);
      if(platform.zones[zone].relayPinCool)platform.writeGPIO(platform.zones[zone].relayPinFan,val?RELAY_ON:RELAY_OFF);
      if(platform.zones[zone].relayPinHeat)platform.writeGPIO(platform.zones[zone].relayPinHeat,RELAY_OFF);
    }else if(HeatCoolMode=="FAN"){
      //platform.log("Fan Pin=",platform.zones[zone].relayPinFan);
      if(platform.zones[zone].relayPinFan)platform.writeGPIO(platform.zones[zone].relayPinFan,val?RELAY_ON:RELAY_OFF);
    }
  }catch(err){
    platform.log('error ln294',JSON.stringify(err));
  }
};
MultiZonePlatform.prototype.returnFileContents=function(url, response){
   var filePath=path.resolve(__dirname,url.substr(1));
   var mimeType=mime.getType(filePath);
   //platform.log(mimeType);
   fs.readFile(filePath, function (err, data) {
        if (err) {
          platform.log("error", "cannot read", filePath, err);
          response.statusCode = 404;
          response.end();
        }else{
          response.setHeader('Content-Type', mimeType || "text/plain");
          response.statusCode = 200;
          response.end(data);
        }
      });
};
MultiZonePlatform.prototype.getStatus=function(simple){
  var retval={};
  //return retval;
  for (var zone in this.zones) {
    var thermostat=this.getThermostatForZone(zone);
    //platform.log("what is",thermostat.displayName, thermostat instanceof Service.Thermostat);
    if(thermostat){
      this.zones[zone]['currentTemp'] = thermostat.getCharacteristic(Characteristic.CurrentTemperature).value;
      this.zones[zone]['setPoint'] = thermostat.getCharacteristic(Characteristic.TargetTemperature).value;
      this.zones[zone]['running'] = platform.systemStateName( thermostat.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value );
      this.zones[zone]['HeatingCoolingState']= platform.systemStateName( thermostat.getCharacteristic(Characteristic.TargetHeatingCoolingState).value );
      this.zones[zone]['temperatureDisplayUnits'] = thermostat.getCharacteristic(Characteristic.TemperatureDisplayUnits).value==Characteristic.TemperatureDisplayUnits.FAHRENHEIT?"F":"C";
      //platform.log(this.zones[zone]['temperatureDisplayUnits']);
    }
  }
  retval.zones=this.zones;
  retval.timestamp=new Date().toISOString();
  retval.enviornment={'cpuTemp':platform.cpuTemp,'weatherData':platform.weatherData};
  var oldestDate=new Date(Date.now() - 24 * 3600 * 1000);
  if(!simple){
    retval.furnaceLog=furnaceLog.filter(entry => Date.parse(entry.timestamp)>oldestDate);
    retval.sensorLog=sensorLog.filter(entry => entry.timestamp ? Date.parse(entry.timestamp)>oldestDate : false);
  }
  return JSON.stringify(retval);
};
MultiZonePlatform.prototype.setTemperature=function(zone, HCState, temp){
  zone=decodeURIComponent(zone);
  var thermostat=this.getThermostatForZone(zone);
  platform.log("set zone", zone, platform.systemStateName(HCState), "to", temp);
  //if(thermostat.temperatureDisplayUnits==Characteristic.TemperatureDisplayUnits.FAHRENHEIT){
  //  temp=(temp-32)*5/9;
  //}
  //if(temp<=service.maxTemperature && temp>=service.minTemperature){
  thermostat.setCharacteristic(Characteristic.TargetHeatingCoolingState,HCState);
  thermostat.setCharacteristic(Characteristic.TargetTemperature,temp);
  platform.updateSystem();
  //}
};
MultiZonePlatform.prototype.startSensorLoops=function(){
  this.sensorInterval=setInterval(
      function(){
        if(platform.hasBME280) {
          platform.readTemperatureFromI2C();
        }
        if(platform.remoteBME280URL){
          platform.readRemoteBME280();
        }
        if(platform.environmentCountdown){
          platform.environmentCountdown--;
        }else{
          platform.environmentCountdown=60;
          platform.readCPUTemperature();
          platform.readLocalWeather();
        }
      }
      ,this.sensorCheckMilliseconds);
  var port = new SerialPort(this.serialCfg);
  platform.msgbuff="";
  port.on('error',function(err){
      platform.log('error',"cannot open serial port - " + err);
  });
  port.on('open', function() {
      platform.log('serial port open');
  });
  port.on('data', function(data){
    platform.msgbuff+=data.toString();
    while(platform.msgbuff.length>11 && platform.msgbuff.length-platform.msgbuff.indexOf("a")>11){
      var pos=platform.msgbuff.indexOf("a")
      var msg=platform.msgbuff.substr(pos,12);
      platform.msgbuff=platform.msgbuff.substr(13);
      var deviceid=msg.substr(1,2);
      var type=msg.substr(3,4);
      if(type=="TEMP"){platform.updateSensorData(deviceid,{ "temp" : Number(msg.substr(7)) });}
      if(type=="BATT"){
	var val=(Number(msg.substr(7,4))-2)*100;
	platform.updateSensorData(deviceid,{ "batt" : val });
	}
    }
  });
};
MultiZonePlatform.prototype.readTemperatureFromI2C = function() {
  try{
    platform.bme280.readSensorData().then((data) => {
      platform.updateSensorData('BM', { 'temp' : data.temperature_C-1.1111, 'press' : data.pressure_hPa, 'humid' : data.humidity });
    });
  }catch(err){platform.log('error ln292',err);}
};
MultiZonePlatform.prototype.readRemoteBME280 = function(){
  if(!platform.remoteBME280URL){return;}
  var getReq = http.request(platform.remoteBME280URL, function(res) {
      var body='';
      res.on('data', function(data) {
        body+=data;
      });
      res.on('end', function(){
        try{
          var sensorData=JSON.parse(body);
          //platform.log("Updated BMR", sensorData.temp);
          platform.updateSensorData('BMR', { 'temp' : sensorData.temp, 'press' : sensorData.press, 'humid' : sensorData.humid, 'batt': sensorData.batt });
        }catch(err){
          platform.log("unable to reach BME");
        }
      });
  });
  //end the request
  getReq.end();
  getReq.on('error', function(err){
    platform.log("unable to reach remoteBME: ", err);
  });
};

MultiZonePlatform.prototype.readCPUTemperature = function(){
  fs.readFile("/sys/class/thermal/thermal_zone0/temp", function (err, data) {
        if (err) {
          platform.log("error", "cannot read CPU Temp", err);
        }else{
          //platform.updateSensorData('CPU', { 'temp' : data/1000 }); 
          platform.cpuTemp=data/1000;
          //platform.log("CPU Temp", platform.cpuTemp);
        }
      });
};
MultiZonePlatform.prototype.readLocalWeather = function(){
  if(!platform.accuweatherURL){return;}
    //     EXAMPLE
    //     http://rss.accuweather.com/rss/liveweather_rss.asp?metric=0&locCode=US|44022'
    //
 
    //making the http get call
    var getReq = http.request(platform.accuweatherURL, function(res) {
        //console.log("\nstatus code: ", res.statusCode);
        var body='';
        res.on('data', function(data) {
          body+=data;
        });
        res.on('end', function(){
          var regex=/Currently:([^:]*):([^<]*)/gm;
          var m = regex.exec(body);
          if(m && m.length==3){
            platform.weatherData={
              'condition':m[1].trim(),
              'temp':m[2].trim()
            };
          }
          //console.log("ended");
        });
    });
 
    //end the request
    getReq.end();
    getReq.on('error', function(err){
        platform.log("cannot get weather data: ", err);
    }); 
};

MultiZonePlatform.prototype.getZoneForDevice=function(deviceid){
  for(var zone in this.zones){
    if(this.zones[zone].sensors[deviceid])return zone;
  }
  return null;
};
MultiZonePlatform.prototype.updateSensorData = function(deviceid, data){
  //platform.log("updateSensorData",deviceid);
  var timestamp=new Date().toISOString();

  var logdata=JSON.parse(JSON.stringify(data));
  logdata.deviceid=deviceid;
  logdata.timestamp=timestamp;
  sensorLog.push(logdata);
  
  var zone = this.getZoneForDevice(deviceid);
  if(!zone){
    this.addAccessory(deviceid);
    for(var i in this.accessories){
      var accessory=this.accessories[i];
      if(accessory.displayName==deviceid){
        var svc=accessory.getService(Service.TemperatureSensor);
        this.setCharacteristics(svc,deviceid,data);
        svc=accessory.getService(Service.BatteryService);
        this.setCharacteristics(svc,deviceid,data);
      }
    }
    return;
  }
  //platform.log("zone", zone," device", deviceid);
  // write the data on the zones object
    for(var val in data){
      this.zones[zone].sensors[deviceid][val]=data[val];
    }
  //}else{
  //  zone="1";
  //}

  // set the characteristics
  var foundAccessories = 0;
  for(var i in this.accessories){
    var accessory=this.accessories[i];
    for(var j in accessory.services){

      var service = accessory.services[j];
      if(service.displayName==deviceid || service.displayName=="Zone"+zone+" Thermostat" || service.displayName=="Zone"+zone+" ThermostatBatt" || service.displayName==deviceid+"Batt")
      {
        foundAccessories++;
        this.setCharacteristics(service,deviceid,data);
      }
    }
  }
  if(foundAccessories<4){
     this.addAccessoriesForSensor(deviceid);
  }
};
MultiZonePlatform.prototype.testCharacteristic=function(service,name){
  // checks for the existence of a characteristic object in the service
  var index, characteristic;
  for (index in service.characteristics) {
    characteristic = service.characteristics[index];
    if (typeof name === 'string' && characteristic.displayName === name) {
      return true;
    }
    else if (typeof name === 'function' && ((characteristic instanceof name) || (name.UUID === characteristic.UUID))) {
      return true;
    }
  }
  for (index in service.optionalCharacteristics) {
    characteristic = service.optionalCharacteristics[index];
    if (typeof name === 'string' && characteristic.displayName === name) {
      return true;
    }
    else if (typeof name === 'function' && ((characteristic instanceof name) || (name.UUID === characteristic.UUID))) {
      return true;
    }
  }
  return false;
}
MultiZonePlatform.prototype.getAverageSensor=function(zone,dataType){
  var count=0,sum=0;
  for(var deviceid in this.zones[zone].sensors){
    var val=this.zones[zone].sensors[deviceid][dataType];
    if(val){sum+=val;count++}
  }
  return count>0 ? Math.round(sum/count) : 0;
};
MultiZonePlatform.prototype.getMinimumSensor=function(zone,dataType){
  var min;
  for(var deviceid in this.zones[zone].sensors){
    var val=this.zones[zone].sensors[deviceid][dataType];
    if(!min || val<min){min=val;}
  }
  return min;
};
MultiZonePlatform.prototype.setCharacteristics = function(service,deviceid,data){
  //platform.log("setCharacteristics",deviceid);
  for(var dataType in data){
    //platform.log("dataType", dataType,"=",data[dataType]);
    //service.sensorData[deviceid][dataType]=data[dataType];
    switch(dataType){
      case 'temp':  
        if(this.testCharacteristic(service,Characteristic.CurrentTemperature))
        {
          //if(service instanceof Service.Thermostat){
          if(service.displayName.indexOf("Thermostat")>0){
            var zone = this.getZoneForDevice(deviceid);
            service.setCharacteristic(Characteristic.CurrentTemperature,this.getAverageSensor(zone,dataType));
          }
          else 
            service.setCharacteristic(Characteristic.CurrentTemperature,Number(data[dataType]));
        }
        break;
      case 'batt':
        if(this.testCharacteristic(service,Characteristic.BatteryLevel))
        {
          var val=Number(data[dataType]);
          //if(service instanceof Service.Thermostat){
          if(service.displayName.indexOf("Thermostat")>0){
            var zone = this.getZoneForDevice(deviceid);
            val=this.getMinimumSensor(zone,dataType);
          }
          if(val<0.0)val=0.0;
          //platform.log(service.displayName,"batteryLevel:",val,"from reading",data[dataType]);
          service.setCharacteristic(Characteristic.BatteryLevel,val);
          service.setCharacteristic(Characteristic.StatusLowBattery,val<30);
        }
        break;
      case 'humid':
        if(this.testCharacteristic(service,Characteristic.CurrentRelativeHumidity))
        {
          //platform.log('set humid');
          service.setCharacteristic(Characteristic.CurrentRelativeHumidity,Number(data[dataType]));
        }
        break;
      case 'press':
        if(this.testCharacteristic(service,AirPressure))
        {
          //platform.log('set press', data[dataType], AirPressure);
          service.setCharacteristic(AirPressure,Number(data[dataType]));
        }
        break;
      default:
          platform.log('error','no support for',dataType,'from sensor',deviceid);
    }
  }
};
MultiZonePlatform.prototype.addAccessoriesForSensor = function(deviceid){
  // no service was assigned this device
  // add all accessories and services needed and set characteristics
 
  //Get the Zone data for the device
  for(var zone in this.zones){
    var sensor=this.zones[zone].sensors[deviceid];
    if(sensor && sensor.source=='serial'){
      //create a temperature sensor
      this.addAccessory(deviceid);
    }
    if(sensor){
      //create a thermostat
      this.addAccessory("Zone"+zone+" Thermostat");
    }
    else
    {
      this.addAccessory(deviceid);
    }
  }
};
MultiZonePlatform.prototype.addAccessory = function(accessoryName) {
  // check we dont already have that one
  for(var i in this.accessories){
    if (this.accessories[i].displayName==accessoryName) {
      return;
    }
  }
  //platform.log("TODO:when do I set defaults in add or configure?");
  platform.log("Add Accessory",accessoryName);
  var uuid = UUIDGen.generate(accessoryName);

  var accessory = new Accessory(accessoryName, uuid);
  accessory.on('identify', function(paired, callback) {
    platform.log(accessory.displayName, "Identify!!!");
    callback();
  });

  this.configureAccessory(accessory);

  var service=accessory.getService(Service.Thermostat);
  if(service){
    platform.log("set thermostat defaults")
    service.setCharacteristic(Characteristic.TargetTemperature, 21);
    service.setCharacteristic(Characteristic.TemperatureDisplayUnits, platform.temperatureDisplayUnits);
    service.setCharacteristic(Characteristic.CurrentHeatingCoolingState, Characteristic.CurrentHeatingCoolingState.OFF);
  }
  this.api.registerPlatformAccessories("homebridge-multizone-thermostat", "MultiZonePlatform", [accessory]);
};
MultiZonePlatform.prototype.configureAccessory = function(accessory) {
  platform.log(accessory.displayName,"Configure Accessory");
  
  // add a Battery service
  //platform.log("add battery service to ", accessory.displayName);
  accessory.batteryService=accessory.getService(Service.BatteryService);
  if(accessory.batteryService==undefined){
    accessory.batteryService=accessory.addService(Service.BatteryService, accessory.displayName+"Batt");
  }
  accessory.batteryService.typename="BatteryService";
  accessory.batteryService.sensorData={};
      
  if(accessory.displayName.indexOf('Zone')>=0){
    this.makeThermostat(accessory);
    var zone=Number(accessory.displayName.substr(4,1));
    if(this.zones[zone].relayPinFan!=undefined){
      this.makeFan(accessory);
    }
  }else{
    this.makeTemperatureSensor(accessory);
  }
  
  accessory.reachable = true;
  this.accessories.push(accessory);
};
MultiZonePlatform.prototype.configurationRequestHandler = function(context, request, callback) {
  platform.log("Context: ", JSON.stringify(context));
  platform.log("Request: ", JSON.stringify(request));

  // Check the request response
  if (request && request.response && request.response.inputs && request.response.inputs.name) {
    this.addAccessory(request.response.inputs.name);

    // Invoke callback with config will let homebridge save the new config into config.json
    // Callback = function(response, type, replace, config)
    // set "type" to platform if the plugin is trying to modify platforms section
    // set "replace" to true will let homebridge replace existing config in config.json
    // "config" is the data platform trying to save
    callback(null, "platform", true, 
        {
          "platform" : "MultiZonePlatform",
          "name" : "MultiZone Platform", 
          "zones" : this.zones,
          "sensorCheckMilliseconds" : this.sensorCheckMilliseconds,
          "startDelay" : this.startDelay,
          "minOnOffTime" : this.minOnOffTime,
          "serverPort" : this.serverPort,
          "serialCfg" : this.serialCfg
        });
    return;
  }

  var respDict = {
    "type": "Interface",
    "interface": "input",
    "title": "Add Accessory",
    "items": [
      {
        "id": "name",
        "title": "Name",
        "placeholder": "Zone Thermostat"
      }
    ]
  };

  context.ts = "MultiZoneContext";
  callback(respDict);
};
MultiZonePlatform.prototype.makeFan=function(accessory){
  // add a Fan service
  accessory.fanService=accessory.getService(Service.Fan);
  if(accessory.fanService==undefined){
    accessory.fanService=accessory.addService(Service.Fan, accessory.displayName+"Fan");
    platform.log("added Fan",accessory.fanService.displayName);
  }
}
MultiZonePlatform.prototype.makeTemperatureSensor=function(accessory){
  accessory.getService(Service.AccessoryInformation)
    .setCharacteristic(Characteristic.Manufacturer, "mcmspark")
    .setCharacteristic(Characteristic.Model, 'Serial Temperature Sensor')
    .setCharacteristic(Characteristic.SerialNumber, '00x000x0000x')
    .setCharacteristic(Characteristic.FirmwareRevision, 'unknown');
  // add a Temerature service
  accessory.tempService=accessory.getService(Service.TemperatureSensor);
  if(accessory.tempService==undefined){
    accessory.tempService=accessory.addService(Service.TemperatureSensor, accessory.displayName);
    if(accessory.displayName.indexOf('BM')==0){
      accessory.tempService.addCharacteristic(AirPressure);
    }
    platform.log("added TemperatureSensor");
  }
};
MultiZonePlatform.prototype.makeThermostat=function(accessory){
  //platform.log("makeThermostat",accessory.displayName);
  var zone=accessory.displayName.substr(accessory.displayName.indexOf("Zone")+4,1);
  
  accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, "mcmspark")
      .setCharacteristic(Characteristic.Model, 'Zone Thermostat')
      .setCharacteristic(Characteristic.SerialNumber, '00x000x0000x')
      .setCharacteristic(Characteristic.FirmwareRevision, '1');
    // add a Thermostat service
  accessory.thermostatService=accessory.getService(Service.Thermostat);
    if(accessory.thermostatService==undefined){
      accessory.thermostatService=accessory.addService(Service.Thermostat, accessory.displayName);
      platform.log("added ThermostatService");
    }
    //override targetTemp characteristic
  var characteristic=accessory.thermostatService.getCharacteristic(Characteristic.TargetTemperature);
  characteristic.validateValue = (temp) => {
    // check that the temp is reasonable for the units (default assumed to be celsius
    if(temp>=platform.reasonableTemperatures[1].low && temp<=platform.reasonableTemperatures[1].high){
       // this is the reasonable range for the fahrenheit scale
	platform.log("get a request in Fahrenheit",temp,"converting to Celsius");
       // convert to celsius
       temp=(Number(temp)-32)*5/9;
    }
    if(temp>=platform.reasonableTemperatures[0].low && temp<=platform.reasonableTemperatures[0].high){
       // this is the reasonable range for the celsius scale
       return Math.round( Number(temp)*10 )/10;
    }
    return 21
  };
  //characteristic.props.maxValue=37.8;
  characteristic.on('set', (temp, callback, context) => {
    platform.log('SET TargetTemperature from', characteristic.value, 'to', temp);
    callback(null,temp);
  });
  for(var d in platform.zones[zone]["sensors"]){
    var sensor=platform.zones[zone]["sensors"][d];
    if(sensor['extras'].indexOf('press')>=0){
      // add AirPressure Characteristic
      // This causes a warning
      if(accessory.thermostatService.getCharacteristic(AirPressure)==undefined){
        accessory.thermostatService.addCharacteristic(AirPressure);
        platform.log("added AirPressure Characteristic");
      }
    }
  }
};
MultiZonePlatform.prototype.systemStateValue=function(heatingCoolingStateName) {
  if (heatingCoolingStateName.toUpperCase() === 'HEAT'){
    return Characteristic.CurrentHeatingCoolingState.HEAT
  } else if (heatingCoolingStateName.toUpperCase() === 'COOL') {
    return Characteristic.CurrentHeatingCoolingState.COOL;
  } else {
    return Characteristic.CurrentHeatingCoolingState.OFF;
  }
};
MultiZonePlatform.prototype.systemStateName=function(heatingCoolingState) {
  if (heatingCoolingState === Characteristic.CurrentHeatingCoolingState.HEAT) {
    return 'HEAT';
  } else if (heatingCoolingState === Characteristic.CurrentHeatingCoolingState.COOL) {
    return 'COOL';
  } else if (heatingCoolingState == "FAN"){
    return "FAN";
  } else {
    return 'OFF';
  }
};
MultiZonePlatform.prototype.getFanForZone=function(zone){
  for(var i in this.accessories){
    var accessory=this.accessories[i];
    var service=accessory.getService(Service.Fan);
    if(service && service.displayName=="Zone"+zone+" ThermostatFan")
    {
      //platform.log("Found", service.displayName,zone);
      return service
    }
  }
  //platform.log("no Fan Found in zone",zone);
  return null;
};
MultiZonePlatform.prototype.getThermostatForZone=function(zone){
  for(var i in this.accessories){
    var accessory=this.accessories[i];
    var service=accessory.getService(Service.Thermostat);
    if(service && service.displayName=="Zone"+zone+" Thermostat")
    {
      //platform.log("Found", service.displayName,zone);
      return service
    }
  }
  platform.log("ERROR:  this should not be null", zone);
  return null;
};
MultiZonePlatform.prototype.currentlyRunning=function(service){
  return platform.systemStateName(service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value);
};
MultiZonePlatform.prototype.shouldTurnOnHeating=function(targetState,currentTemp,targetTemperature){
  return (targetState === Characteristic.TargetHeatingCoolingState.HEAT && 
          currentTemp < targetTemperature);
};
MultiZonePlatform.prototype.shouldTurnOnCooling=function(targetState,currentTemp,targetTemperature){
  return (targetState === Characteristic.TargetHeatingCoolingState.COOL && 
          currentTemp > targetTemperature);
};
MultiZonePlatform.prototype.turnOnSystem=function(zone, service, systemToTurnOn) {
    if(service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value === Characteristic.CurrentHeatingCoolingState.OFF){
      //platform.log("pre",service.preSensordata);
      platform.log("START",this.systemStateName(systemToTurnOn), service.displayName, service.getCharacteristic(Characteristic.CurrentTemperature).value);
      //platform.log("sensorData",JSON.stringify(service.sensorData));
      furnaceLog.push({"zone":zone, "run":true, "timestamp":(new Date().toISOString())});
      platform.updateGPIO(zone, systemToTurnOn, ON);
      service.setCharacteristic(Characteristic.CurrentHeatingCoolingState, systemToTurnOn);
      this.lastCurrentHeatingCoolingStateChangeTime=new Date();
    } else if (service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value !== systemToTurnOn) {
      // if we want heat but it is cooling or vis versa
      this.turnOffSystem(zone, service, service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value);
    }
};
MultiZonePlatform.prototype.timeSinceLastHeatingCoolingStateChange=function(){
  return (new Date() - this.lastCurrentHeatingCoolingStateChangeTime);
};
MultiZonePlatform.prototype.turnOffSystem=function(zone, service, systemToTurnOff){
  //platform.log("pre",service.preSensordata);
  platform.log("STOP",platform.currentlyRunning(service) , service.displayName, service.getCharacteristic(Characteristic.CurrentTemperature).value);
  //platform.log("sensorData",JSON.stringify(service.sensorData));
  furnaceLog.push({"zone":zone, "run":false, "timestamp":(new Date().toISOString())});
  platform.updateGPIO(zone, systemToTurnOff, OFF);
  service.setCharacteristic(Characteristic.CurrentHeatingCoolingState, Characteristic.CurrentHeatingCoolingState.OFF);
  this.lastCurrentHeatingCoolingStateChangeTime=new Date();
};  
MultiZonePlatform.prototype.updateSystem=function(){
  //platform.log("updating...");  
  var changed=false;
  for(var zone in platform.zones){
    var service=platform.getThermostatForZone(zone);
    if(service){
      //platform.log("updateSystem",service.displayName);
      // read all values service.averageSensorValue('temp')
      var currentState=service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value;
      var targetState=service.getCharacteristic(Characteristic.TargetHeatingCoolingState).value;
      var currentTemp=service.getCharacteristic(Characteristic.CurrentTemperature).value;
      var targetTemperature=service.getCharacteristic(Characteristic.TargetTemperature).value;
      //service.heatingThresholdTemperature=service.getCharacteristic(Characteristic.HeatingThresholdTemperature).value;
      //service.coolingThresholdTemperature=service.getCharacteristic(Characteristic.CoolingThresholdTemperature).value;
      
      //platform.log("Eval",currentState,targetState,currentTemp,targetTemperature,this.shouldTurnOnHeating(targetState,currentTemp,targetTemperature));

      if (currentState === Characteristic.CurrentHeatingCoolingState.OFF
          && targetState !== Characteristic.TargetHeatingCoolingState.OFF) {
        //platform.log("it is currently off and it should not be");
        if (platform.shouldTurnOnHeating(targetState,currentTemp,targetTemperature)) {
          platform.turnOnSystem(zone,service,Characteristic.CurrentHeatingCoolingState.HEAT);
        } else if (platform.shouldTurnOnCooling(targetState,currentTemp,targetTemperature)) {
          platform.turnOnSystem(zone,service,Characteristic.CurrentHeatingCoolingState.COOL);
        } 
      } else if (currentState !== Characteristic.CurrentHeatingCoolingState.OFF
          && targetState === Characteristic.TargetHeatingCoolingState.OFF) {
            //platform.log("it is currenty not off and it should be");
            platform.turnOffSystem(zone,service,currentState);
      } else if (currentState !== Characteristic.CurrentHeatingCoolingState.OFF
          && targetState !== Characteristic.TargetHeatingCoolingState.OFF) {
            //platform.log("it is currently not off and it should be not off");
        if (platform.shouldTurnOnHeating(targetState,currentTemp,targetTemperature)) {
          platform.turnOnSystem(zone,service,Characteristic.CurrentHeatingCoolingState.HEAT);
        } else if (platform.shouldTurnOnCooling(targetState,currentTemp,targetTemperature)) {
          platform.turnOnSystem(zone,service,Characteristic.CurrentHeatingCoolingState.COOL);
        } else {
          platform.turnOffSystem(zone,service,Characteristic.CurrentHeatingCoolingState.OFF);
        }
      } 
      if (platform.timeSinceLastHeatingCoolingStateChange() > platform.minOnOffTime*4) {
        //just sync up Hardware periodically 
        platform.updateGPIO(zone,currentState, currentState !== Characteristic.CurrentHeatingCoolingState.OFF ? ON : OFF);
        changed=true;
      }
    }
    service=platform.getFanForZone(zone);
    if(service){
      var fanState=service.getCharacteristic(Characteristic.On).value;
      if(service.currentFanState!=fanState){
        platform.updateGPIO(zone, "FAN", fanState);
        service.currentFanState=fanState;
	}
    }

  }
  if(changed){
    platform.lastCurrentHeatingCoolingStateChangeTime=new Date();
    //platform.log("reset timer");
  }
  //platform.log("check for alarms");
  // send alarm message if temp is low
  for(var zone in platform.zones){
	//platform.log(zone);
	for(var deviceid in platform.zones[zone].sensors){
      		var temp=platform.zones[zone].sensors[deviceid].temp;
		//platform.log("check for alarm",deviceid,temp,platform.alarmTemp);
		if(temp && temp<platform.alarmTemp){
			platform.log("LOW TEMP ALARM", deviceid);
			platform.sendSNSMessage("ALARM Temp:"+deviceid+"="+(temp*9/5+32)+"F");
		}
	}
  }
};
MultiZonePlatform.prototype.startControlLoop=function(){
  platform.lastCurrentHeatingCoolingStateChangeTime=new Date();
  platform.log("startControlLoop",platform.minOnOffTime);
  setTimeout(function(){
    for(var zone in platform.zones){
      var service=platform.getThermostatForZone(zone);
      if(service)
        platform.updateGPIO(zone,service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value, ON);
    }
  },10000);
  platform.updateInterval=setInterval(function(){platform.updateSystem();},platform.minOnOffTime);
};
