// The issuance gate reads the live model pins through a kernel port. Every host that can
// reach the gate (API, Start acceptance, worker, repair scripts) installs it before its first read.
export async function installModelAdmissionPins(): Promise<void> {
  const [{ installModelPinReader }, { currentModelPins }] = await Promise.all([
    import('@/kernel/read-models/model-admission'),
    import('./model-slice-registry'),
  ]);
  installModelPinReader(currentModelPins);
}
