const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const fetch = require("node-fetch");
const Cart = require("../models/cartModel");
const CartProduct = require("../models/cartProductModel");
const ProductItem = require("../models/productItemModel");
const Product = require("../models/productModel");
const UserAddress = require("../models/userAddressModel");
const Address = require("../models/addressModel");
const Customer = require("../models/customerModel");
const Country = require("../models/countryModel");
const Transaction = require("../models/transactionModel");
const Sale = require("../models/saleModel");
const SaleItem = require("../models/saleItemModel");
const Balance = require("../models/balanceModel");
const Vendor = require("../models/vendorModel");

// checkout process has validations before start process and preparation for paymob data required and save the transaction and sale in the database
// and some other process for us
exports.checkout = catchAsync(async (req, res, next) => {
  const defaultAddress = await UserAddress.findOne({
    where: {
      user_id: req.user.id,
      is_default: true,
    },
  });
  if (!defaultAddress) {
    return next(new AppError("Specify your default address to processed", 400));
  }
  const address = await Address.findOne({
    where: { id: defaultAddress.address_id },
  });
  if (!address) {
    return next(new AppError("Address not found", 404));
  }

  // -) check all products in the cart for the same vendor
  const user_id = req.user.id;
  const customer = await Customer.findOne({ where: { user_id } });
  if (!customer) {
    return next(new AppError("You are not a customer", 401));
  }
  const cart = await Cart.findOne({ where: { customer_id: customer.id } });
  const cartProducts = await CartProduct.findAll({
    where: { cart_id: cart.id },
  });
  if (cartProducts.length === 0) {
    return next(new AppError("Your cart is empty", 400));
  }

  const vendors = new Set();
  const items = [];
  let amount = 0.0;
  const currency = "EGP";
  const payment_methods = [process.env.CARD_ID * 1];
  let vendor_id;
  for (let i = 0; i < cartProducts.length; i++) {
    const productItem = await ProductItem.findOne({
      where: {
        id: cartProducts[i].product_item_id,
      },
    });
    const product = await Product.findOne({
      where: { id: productItem.product_id },
    });
    vendors.add(productItem.vendor_id);
    vendor_id = productItem.vendor_id;
    if (cartProducts[i].quantity > productItem.quantity) {
      return next(
        new AppError("You ask for larger quantity than already exist", 400)
      );
    }
    const item = {
      name: product.name,
      amount: productItem.price * 100.0,
      description: product.description,
      quantity: cartProducts[i].quantity,
    };
    items.push(item);
    amount += productItem.price * 100.0 * cartProducts[i].quantity;
  }

  if (vendors.size !== 1) {
    return next(
      new AppError("You can not checkout products from different vendors", 400)
    );
  }
  const { first_name, last_name, email } = req.user;
  const country = await Country.findOne({ where: { id: address.country_id } });
  const billing_data = {
    first_name,
    last_name,
    email,
    country: country.name,
    street: address.street_name,
    phone_number: "+201234567890",
  };
  const data = {
    amount,
    currency,
    payment_methods,
    items,
    customer: {
      first_name,
      last_name,
      email,
      extras: {
        re: "22",
      },
    },
    billing_data,
    extras: {
      ee: null,
    },
  };
  // paymob needs
  const myHeaders = new Headers();
  myHeaders.append("Authorization", `Token ${process.env.SECRET_KEY}`);
  myHeaders.append("Content-Type", "application/json");

  const raw = JSON.stringify(data);
  const requestOptions = {
    method: "POST",
    headers: myHeaders,
    body: raw,
    redirect: "follow",
  };

  const response = await fetch(
    "https://accept.paymob.com/v1/intention/",
    requestOptions
  );
  const result = await response.json();
  const client_secret = result.client_secret;
  const url = `https://accept.paymob.com/unifiedcheckout/?publicKey=${process.env.PUBLIC_KEY}&clientSecret=${client_secret}`;
  const key = result.payment_keys[0].key;
  const frame = `https://accept.paymob.com/api/acceptance/iframes/838725?payment_token=${key}`;

  amount /= 100.0;

  // now we create our needs
  const transaction = await Transaction.create({
    status: "pending",
  });
  const sale = await Sale.create({
    customer_id: customer.id,
    transaction_id: transaction.id,
    total_price: amount * 1.0,
    status: "pending",
    intent_id: result.id,
    vendor_id,
    address_id: address.id,
  });
  for (let i = 0; i < cartProducts.length; i++) {
    const productItem = await ProductItem.findOne({
      where: {
        id: cartProducts[i].product_item_id,
      },
    });
    productItem.quantity -= cartProducts[i].quantity;
    await productItem.save();
    const saleItem = await SaleItem.create({
      sale_id: sale.id,
      product_item_id: productItem.id,
      quantity: cartProducts[i].quantity,
    });
  }
  res.status(200).json({
    status: "success",
    url,
    frame,
  });
});

// callback
exports.checkoutCallback = catchAsync(async (req, res, next) => {
    console.log('checkoutCallback: ', req.body);
    // take intent_id as string
    const intent_id = req.body.intention.id;
    const success = req.body.transaction.success;
    if (!success || !intent_id) {
        return next(new AppError("Something went wrong", 400));
    }
    const sale = await Sale.findOne({ where: { intent_id } });
    if (!sale) {
        return next(new AppError("Sale not found", 404));
    }
    const transaction = await Transaction.findOne({
        where: { id: sale.transaction_id },
    });
    const saleItems = await SaleItem.findAll({ where: { sale_id: sale.id } });
    console.log(req.body);
    if(req.body.transaction.is_refunded === true)
    {
        return next(new AppError("Transaction is refunded", 400));
    }
    if (success === true) {
        transaction.status = "success";
        transaction.transaction_id = req.body.transaction.id;
        await transaction.save();
        // empty cart
        const customer = await Customer.findOne({
        where: { id: sale.customer_id },
        });
        const cart = await Cart.findOne({ where: { customer_id: customer.id } });
        const cartProducts = await CartProduct.findAll({
        where: { cart_id: cart.id },
        });
        cartProducts.forEach(async (cartProduct) => {
        await cartProduct.destroy();
        });
        // add balance
        const balance = await Balance.findOne({
        where: { vendor_id: sale.vendor_id },
        });
        // 5% commission
        let amount = sale.total_price * 1.0;
        amount = amount - amount * 0.05; 
        balance.pending_credit = balance.pending_credit * 1.0 + amount;
        await balance.save();
    }   
    else {
        transaction.status = "cancelled";
        sale.status = "cancelled";
        await transaction.save();
        await sale.save();
        for (let i = 0; i < saleItems.length; i++) {
        const productItem = await ProductItem.findOne({
            where: {
            id: saleItems[i].product_item_id,
            },
        });
        productItem.quantity += saleItems[i].quantity;
        await productItem.save();
        }
    }
    res.status(200).json({
        status: "success",
    });
});

exports.cancelSale = catchAsync(async (req, res, next) => {
    // if the sale is pending, we can cancel it
    // if the sale is success, we can not cancel it
    // if the sale is cancelled, we can not cancel it
    const sale = await Sale.findOne({ where: { id: req.params.id } });
    if (!sale) {
        return next(new AppError("Sale not found", 404));
    }
    if (sale.status === "success") {
      return next(new AppError("Sale is already success", 400));
    }
    if (sale.status === "cancelled") {
      return next(new AppError("Sale is already cancelled", 400));
    }
    if(req.user.role === 'vendor')
    {
        const vendor = await Vendor.findOne({ where: { user_id: req.user.id } });
        if (!vendor) {
          return next(new AppError("You are not a vendor", 401));
        }
        if (sale.vendor_id !== vendor.id) {
          return next(new AppError("You can not cancel this sale you don't own", 401));
        }
    }
    if(req.user.role === 'customer')
    {
        const customer = await Customer.findOne({ where: { user_id: req.user.id } });
        if (!customer) {
          return next(new AppError("You are not a customer", 401));
        }
        if (sale.customer_id !== customer.id) {
          return next(new AppError("You can not cancel this sale you don't have", 401));
        }
    }
    const transaction = await Transaction.findOne({ where: { id: sale.transaction_id } });
    if (!transaction) {
      return next(new AppError("Transaction not found", 404));
    }
    if(req.user.role === 'customer')
    {
        if(transaction.status !== 'pending' || sale.status !== 'pending')
            return next(new AppError("You can not cancel this sale", 400));
    }
    sale.status = "cancelled";
    await sale.save();
    // if transaction is pending, we can cancel it
    // if transaction is success, we refund it
    if (transaction.status === "success") {
        // refund the user
        
        const headers = new Headers();
        headers.append("Authorization", `Token ${process.env.SECRET_KEY}`);
        headers.append("Content-Type", "application/json");
        let amount = sale.total_price * 1.0;
        amount *= 100.0;
        const raw = JSON.stringify({ amount, transaction_id: transaction.transaction_id });
        const requestOptions = {
          method: "POST",
          headers,
          body: raw,
          redirect: "follow",
        };
        
        const response = await fetch(
          "https://accept.paymob.com/api/acceptance/void_refund/refund",
          requestOptions
        );
        
        const result = await response.json();
        if(result.success === true)
        {
            transaction.status = "refunded";
            await transaction.save();
        }
        else
        {
            console.log('refund failed for transaction id: ', transaction.transaction_id);
            return next(new AppError("Refund failed", 400));
        }
        // return the balance from the vendor
        const balance = await Balance.findOne({ where: { vendor_id: sale.vendor_id } });
        // 5% commission
        console.log('sale.total_price: ', sale.total_price * 1.0);
        amount = sale.total_price * 1.0;
        amount = amount - amount * 0.05;
        balance.pending_credit = balance.pending_credit * 1.0 - amount;
        await balance.save();
    }
    else if (transaction.status === "pending") {
      transaction.status = "cancelled";
      await transaction.save();
    }
    // return the quantity to the product item
    const saleItems = await SaleItem.findAll({ where: { sale_id: sale.id } });
    for (let i = 0; i < saleItems.length; i++) {
      const productItem = await ProductItem.findOne({ where: { id: saleItems[i].product_item_id } });
        productItem.quantity += saleItems[i].quantity;
        await productItem.save();
    }
    res.status(200).json({
      status: "success",
      message: "Sale cancelled successfully",
    });    
});