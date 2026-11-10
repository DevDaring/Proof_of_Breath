// Prints SDK version and cameras, without opening a camera or using credit.
import { SmartSpectraSDK } from '@smartspectra/node-sdk';

console.log('SmartSpectra SDK', SmartSpectraSDK.version);
const cameras = SmartSpectraSDK.availableCameras();
console.log(cameras.length ? cameras : 'No camera found on this machine.');
