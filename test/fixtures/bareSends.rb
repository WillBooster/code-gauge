def helper
  1
end

def run(seed)
  helper
  seed
  total = helper
  total
end

def shadowed
  helper = 1
  helper
end

def lexical_order
  value
  value = 2
  value
end

def blocks(list)
  outer = 0
  list.each do |item|
    outer
    inner = item
    helper
  end
  inner
end

def rescue_binding
  helper
rescue StandardError => error
  error
end

def pattern_binding(input)
  case input
  in [head, *tail]
    head
  in { name: }
    name
  end
  input => captured
  captured
end

def regex_binding(text)
  /(?<year>\d+)/ =~ text
  year
  month
end

def reversed_regex_binding(text)
  text =~ /(?<year>\d+)/
  year
end

def numbered_params(list)
  list.map { _1.name }
  list.map { it.label }
  _1
end

def aliasing
  alias c a
  helper
end

def introspection
  defined?(helper)
end

def pseudo_variables
  puts __FILE__
  puts __LINE__
  puts __ENCODING__
end

def undefining
  undef gone
  helper
end

def quoted_regex_binding(text)
  /(?'year'\d+)/ =~ text
  year
end

def rhs_before_binding
  /(?<year>\d+)/ =~ year
  year
end
