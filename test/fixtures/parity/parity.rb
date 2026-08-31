def classify(items, limit)
  total = 0
  for item in items
    if item > limit && item % 2 == 0
      total += item
    elsif item < 0
      total -= 1
    else
      total += 1
    end
  end
  case total % 3
  when 0
    "zero"
  when 1
    "one"
  else
    "other"
  end
end
