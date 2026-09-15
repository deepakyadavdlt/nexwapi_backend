-- Autocheckout workflow fields on CommerceSetting
ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "shippingMode" TEXT NOT NULL DEFAULT 'free';
ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "shippingAmount" TEXT NOT NULL DEFAULT '0';
ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "freeShippingAbove" TEXT NOT NULL DEFAULT '2000';
ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "discountEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "discountType" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "discountValue" TEXT NOT NULL DEFAULT '0';
ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "paymentMethod" TEXT NOT NULL DEFAULT 'cod';
ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "proceedMessage" TEXT NOT NULL DEFAULT 'Thanks for your cart! {{shipping_note}} Your total order value is {{total_order_value}}. Would you like to go ahead with the order?';
ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "askNameMessage" TEXT NOT NULL DEFAULT 'Great! We will require some details to ship the order. Please provide your full name.';
ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "askPincodeMessage" TEXT NOT NULL DEFAULT 'Please provide the Pincode/Postcode/Zipcode of the delivery location.';
ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "askAddressMessage" TEXT NOT NULL DEFAULT 'Please enter your street address, building name/number, flat number, floor etc. For example: 123, MG Road, Kusum Apartments, Flat no. 123, 1st floor.';
ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "confirmOrderMessage" TEXT NOT NULL DEFAULT 'Thanks for providing the details! We have noted your address as: {{address}}. {{payment_note}} Would you like to confirm the order?';
ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "cancelMessage" TEXT NOT NULL DEFAULT 'No problem! Your cart is saved. Message us anytime when you are ready to order.';
ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "shippingConfirmed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "discountsConfirmed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CommerceSetting" ADD COLUMN IF NOT EXISTS "paymentConfirmed" BOOLEAN NOT NULL DEFAULT false;
