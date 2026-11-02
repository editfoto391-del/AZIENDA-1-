export function updateGrvReceivedQuantity(line, value) {
  const previousReceived = Number(line.actual_received_quantity) || 0;
  const accepted = Number(line.accepted_quantity) || 0;
  const received = Number(value) || 0;

  return {
    ...line,
    actual_received_quantity: received,
    ...(accepted === previousReceived ? { accepted_quantity: received } : {}),
  };
}
