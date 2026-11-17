INSERT INTO coupon (name, total_stock, stock, status, min_order_amount, discount_amount, gift_name, max_uses_per_user)
SELECT offer.name, 50, 50, 'ACTIVE', offer.minimum, offer.discount, offer.gift, offer.uses
FROM (VALUES
    ('Kitchen starter savings', 75, 10, NULL, 1),
    ('Cookware essentials', 100, 15, NULL, 2),
    ('A gift for your kitchen', 100, 0, 'Silicone oven mitt', 1)
) AS offer(name, minimum, discount, gift, uses)
WHERE NOT EXISTS (SELECT 1 FROM coupon WHERE coupon.name = offer.name);
